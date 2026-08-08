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
import {
  CAROUSEL_MAX_ITEMS,
  MEDIA_TYPE_BY_PLATFORM,
  SCHEDULED_POST_TYPES,
} from "@/lib/scheduler/types";
import { getMediaStorage, mediaKindFor } from "@/lib/storage";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const targetSchema = z.object({
  connectedAccountId: z.string().min(1),
  mediaType: z.enum(SCHEDULED_POST_TYPES),
  /** Per-platform caption override — hashtag conventions differ per network. */
  caption: z.string().max(5000).optional(),
  platformOptions: z.record(z.string(), z.unknown()).optional(),
});

/**
 * One uploaded file, in the order it should appear.
 *
 * Deliberately minimal: only the storage key and what the BROWSER knows that
 * the server cannot cheaply learn. MIME type, size and kind are all read back
 * from storage rather than accepted here — a client that could declare its own
 * kind could label a video as an image and route it down Instagram's
 * `image_url` path, which fails as an opaque container ERROR ten minutes later.
 */
const mediaItemSchema = z.object({
  storageKey: z.string().min(1),
  /** Probed from an <img>/<video> element; absent when probing failed. */
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** e.g. "4:5" when the user accepted a crop. Null/absent = untouched original. */
  croppedToRatio: z.string().max(16).optional(),
});

const createSchema = z.object({
  // Ordered: index IS carousel position. Ten is Instagram's ceiling and the
  // largest any platform accepts.
  media: z.array(mediaItemSchema).min(1).max(CAROUSEL_MAX_ITEMS),
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
      // The calendar shows a thumbnail per post, and a carousel's first item
      // is the one it shows — so order matters even in the list view.
      media: { orderBy: { position: "asc" } },
    },
  });

  return NextResponse.json({
    success: true,
    data: posts.map((post) => ({
      ...post,
      // BigInt does not survive JSON.stringify, and every item carries one.
      media: post.media.map((item) => ({
        ...item,
        sizeBytes: Number(item.sizeBytes),
      })),
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

  const { caption, targets } = parsed.data;
  const scheduledAt = new Date(parsed.data.scheduledAt);

  // Confirm every file exists and read its real size AND content type from
  // storage rather than trusting the client. Size drives TikTok's chunk plan
  // and YouTube's Content-Length, where a wrong value fails mid-upload; content
  // type decides which Instagram path the file takes.
  const storage = getMediaStorage();
  const mediaItems: Array<{
    position: number;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    kind: ReturnType<typeof mediaKindFor>;
    widthPx: number | null;
    heightPx: number | null;
    durationMs: number | null;
    croppedToRatio: string | null;
  }> = [];

  for (const [index, item] of parsed.data.media.entries()) {
    let stat: { size: number; contentType: string };
    try {
      stat = await storage.stat(item.storageKey);
    } catch {
      return NextResponse.json(
        {
          success: false,
          error:
            parsed.data.media.length > 1
              ? `Item ${index + 1} was not found in storage — upload it again`
              : "Uploaded media not found — upload it again",
        },
        { status: 400 }
      );
    }

    mediaItems.push({
      // Position comes from array order, never from the client: it must be
      // contiguous from 0 or the unique index rejects the write.
      position: index,
      storageKey: item.storageKey,
      mimeType: stat.contentType,
      sizeBytes: stat.size,
      kind: mediaKindFor(stat.contentType),
      widthPx: item.widthPx ?? null,
      heightPx: item.heightPx ?? null,
      durationMs: item.durationMs ?? null,
      croppedToRatio: item.croppedToRatio ?? null,
    });
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

    const mediaIssue = validateMediaForPlatform(
      platform,
      target.mediaType,
      mediaItems
    );
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
          mediaType: target.mediaType,
          caption: target.caption ?? caption,
          platformOptions: (target.platformOptions ?? {}) as object,
          scheduledAt,
          status: "QUEUED",
          batchId,
          // Every fan-out target gets its OWN media rows, but they deliberately
          // share storage keys — the files are uploaded once and every platform
          // reads the same bytes. That is why deleting one post's media checks
          // for other references first.
          media: {
            create: mediaItems.map((item) => ({
              ...item,
              sizeBytes: BigInt(item.sizeBytes),
            })),
          },
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
