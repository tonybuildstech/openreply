import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { SocialPlatform } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getPublishQueue } from "@/lib/queue/client";
import { getDispatchMode } from "@/lib/scheduler/adapters";
import {
  validateMediaForPlatform,
  validateScheduleWindow,
} from "@/lib/scheduler/constraints";
import { getYouTubeQuotaState } from "@/lib/scheduler/quota";
import { MEDIA_TYPE_BY_PLATFORM } from "@/lib/scheduler/types";
import { getMediaStorage } from "@/lib/storage";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const targetSchema = z.object({
  connectedAccountId: z.string().min(1),
  mediaType: z.enum([
    "REEL",
    "SHORT",
    "TIKTOK_VIDEO",
    "FACEBOOK_REEL",
    "FACEBOOK_VIDEO",
  ]),
  /** Per-platform caption override — hashtag conventions differ per network. */
  caption: z.string().max(5000).optional(),
  platformOptions: z.record(z.string(), z.unknown()).optional(),
});

const createSchema = z.object({
  mediaStorageKey: z.string().min(1),
  mediaMimeType: z.string().min(1),
  caption: z.string().max(5000).default(""),
  scheduledAt: z.string().datetime(),
  targets: z.array(targetSchema).min(1).max(20),
});

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const status = request.nextUrl.searchParams.get("status");

  const posts = await prisma.scheduledPost.findMany({
    where: {
      workspaceId: context.workspaceId,
      ...(status ? { status: status as never } : {}),
    },
    orderBy: { scheduledAt: "desc" },
    take: 200,
    include: {
      connectedAccount: {
        select: {
          id: true,
          platform: true,
          displayName: true,
          avatarUrl: true,
          status: true,
        },
      },
    },
  });

  return NextResponse.json({
    success: true,
    data: posts.map((post) => ({
      ...post,
      // BigInt does not survive JSON.stringify.
      mediaSizeBytes: Number(post.mediaSizeBytes),
    })),
  });
}

/**
 * Schedule one video to N accounts.
 *
 * Two things happen here that are easy to get wrong:
 *
 *  1. **Validation is per target**, because the platforms genuinely differ —
 *     Facebook refuses anything more than 75 days out, YouTube wants an hour of
 *     lead time, TikTok accepts MOV where Instagram does not. A target that
 *     fails validation is rejected before anything is written.
 *
 *  2. **NATIVE platforms are dispatched immediately.** Facebook and YouTube
 *     hold the schedule themselves, so the upload happens now and the platform
 *     publishes later. Only Instagram and TikTok wait for the worker.
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: z.prettifyError(parsed.error) },
      { status: 400 }
    );
  }

  const { mediaStorageKey, mediaMimeType, caption, targets } = parsed.data;
  const scheduledAt = new Date(parsed.data.scheduledAt);

  // Confirm the media exists and take its real size from storage rather than
  // trusting the client — the size drives TikTok's chunk plan and YouTube's
  // Content-Length, and a wrong value fails mid-upload.
  let mediaSize: number;
  try {
    const stat = await getMediaStorage().stat(mediaStorageKey);
    mediaSize = stat.size;
  } catch {
    return NextResponse.json(
      { success: false, error: "Uploaded media not found — upload it again" },
      { status: 400 }
    );
  }

  const accounts = await prisma.connectedAccount.findMany({
    where: {
      workspaceId: context.workspaceId,
      id: { in: targets.map((t) => t.connectedAccountId) },
    },
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  // Validate every target before writing any of them: a partially-scheduled
  // fan-out is worse than a rejected one.
  const errors: Array<{ connectedAccountId: string; error: string }> = [];
  let youtubeTargets = 0;

  for (const target of targets) {
    const account = accountById.get(target.connectedAccountId);
    if (!account) {
      errors.push({
        connectedAccountId: target.connectedAccountId,
        error: "Account not found in this workspace",
      });
      continue;
    }
    if (account.status !== "ACTIVE") {
      errors.push({
        connectedAccountId: target.connectedAccountId,
        error:
          account.status === "NEEDS_REAUTH"
            ? "Reconnect this account before scheduling to it"
            : "This account is disabled",
      });
      continue;
    }

    const platform = account.platform as SocialPlatform;

    if (!MEDIA_TYPE_BY_PLATFORM[platform].includes(target.mediaType)) {
      errors.push({
        connectedAccountId: target.connectedAccountId,
        error: `${target.mediaType} is not valid for this platform`,
      });
      continue;
    }

    const mediaIssue = validateMediaForPlatform(platform, {
      mimeType: mediaMimeType,
      sizeBytes: mediaSize,
    });
    if (mediaIssue) {
      errors.push({
        connectedAccountId: target.connectedAccountId,
        error: mediaIssue,
      });
      continue;
    }

    const windowIssue = validateScheduleWindow(platform, scheduledAt);
    if (windowIssue) {
      errors.push({
        connectedAccountId: target.connectedAccountId,
        error: windowIssue.message,
      });
      continue;
    }

    if (platform === "YOUTUBE") youtubeTargets += 1;
  }

  // YouTube's ~6-uploads-per-day ceiling is project-wide. Refusing here beats
  // letting the upload fail at fire time, where nobody is watching.
  if (youtubeTargets > 0) {
    const quota = await getYouTubeQuotaState();
    if (youtubeTargets > quota.remainingUploads) {
      errors.push({
        connectedAccountId: "youtube",
        error: `Only ${quota.remainingUploads} YouTube upload(s) left in today's quota (each costs 1,600 of 10,000 daily units). Resets at UTC midnight.`,
      });
    }
  }

  if (errors.length > 0) {
    return NextResponse.json(
      { success: false, error: "Some targets are not valid", data: { errors } },
      { status: 400 }
    );
  }

  const batchId = randomUUID();

  const created = await prisma.$transaction(
    targets.map((target) =>
      prisma.scheduledPost.create({
        data: {
          workspaceId: context.workspaceId,
          connectedAccountId: target.connectedAccountId,
          mediaStorageKey,
          mediaMimeType,
          mediaSizeBytes: BigInt(mediaSize),
          mediaType: target.mediaType,
          caption: target.caption ?? caption,
          platformOptions: (target.platformOptions ?? {}) as object,
          scheduledAt,
          status: "QUEUED",
          batchId,
        },
      })
    )
  );

  // Hand the NATIVE platforms to the worker NOW rather than at fire time —
  // Facebook and YouTube want the bytes up front so they can hold the timer.
  //
  // Enqueued rather than awaited: the upload can be hundreds of megabytes and
  // take minutes, which is not something an HTTP request should be holding
  // open. The worker owns it, with the same retry and backoff as every other
  // publish.
  const queue = getPublishQueue();
  const nativePosts = created.filter((post) => {
    const account = accountById.get(post.connectedAccountId);
    return account && getDispatchMode(account.platform) === "NATIVE";
  });

  await Promise.all(
    nativePosts.map((post) =>
      queue.add(
        "publish-post",
        { scheduledPostId: post.id },
        { jobId: `publish_${post.id}` }
      )
    )
  );

  return NextResponse.json({
    success: true,
    data: {
      batchId,
      created: created.length,
      scheduledPostIds: created.map((p) => p.id),
      // Native uploads start immediately; the rest wait for their slot.
      uploadingNow: nativePosts.length,
    },
  });
}
