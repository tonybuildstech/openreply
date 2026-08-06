import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getPublishQueue } from "@/lib/queue/client";
import { getAdapter } from "@/lib/scheduler/adapters";
import {
  PLATFORM_CONSTRAINTS,
  validateMediaForPlatform,
  validateScheduleWindow,
} from "@/lib/scheduler/constraints";
import {
  getEditPolicy,
  rejectedFields,
  type EditableField,
} from "@/lib/scheduler/editing";
import { MEDIA_TYPE_BY_PLATFORM } from "@/lib/scheduler/types";
import { getMediaStorage } from "@/lib/storage";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const actionSchema = z.object({ action: z.enum(["retry", "cancel"]) });

const patchSchema = z
  .object({
    caption: z.string().max(5000).optional(),
    scheduledAt: z.string().datetime().optional(),
    mediaType: z
      .enum([
        "REEL",
        "SHORT",
        "TIKTOK_VIDEO",
        "FACEBOOK_REEL",
        "FACEBOOK_VIDEO",
      ])
      .optional(),
    platformOptions: z.record(z.string(), z.unknown()).optional(),
    // Swapping the file requires a fresh upload first; the client sends the new
    // key from /api/media/upload.
    mediaStorageKey: z.string().min(1).optional(),
    mediaMimeType: z.string().min(1).optional(),
  })
  // Both media fields travel together or the record would describe one file
  // with another's MIME type.
  .refine(
    (d) => Boolean(d.mediaStorageKey) === Boolean(d.mediaMimeType),
    "mediaStorageKey and mediaMimeType must be sent together"
  );

/** One post plus what may still be changed about it. */
export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const post = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId: context.workspaceId },
    include: {
      connectedAccount: {
        select: {
          id: true,
          platform: true,
          displayName: true,
          avatarUrl: true,
          status: true,
          metadata: true,
        },
      },
    },
  });

  if (!post) {
    return NextResponse.json(
      { success: false, error: "Scheduled post not found" },
      { status: 404 }
    );
  }

  const metadata = (post.connectedAccount.metadata ?? {}) as {
    postMode?: "INBOX" | "DIRECT_POST";
  };

  return NextResponse.json({
    success: true,
    data: {
      ...post,
      // BigInt does not survive JSON.stringify.
      mediaSizeBytes: Number(post.mediaSizeBytes),
      connectedAccount: {
        ...post.connectedAccount,
        metadata: undefined,
        tiktokPostMode: metadata.postMode ?? null,
      },
      policy: getEditPolicy(post.status, post.connectedAccount.platform),
      constraints: PLATFORM_CONSTRAINTS[post.connectedAccount.platform],
    },
  });
}

/**
 * Edit a scheduled post.
 *
 * The hard part is not the database write — it is that a `SCHEDULED_REMOTE`
 * post is already sitting on YouTube or Facebook. For those, the platform is
 * told first and our row is only committed if it accepts. Getting that order
 * wrong would leave the dashboard describing a post that publishes differently.
 */
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

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

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: z.prettifyError(parsed.error) },
      { status: 400 }
    );
  }

  const post = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId: context.workspaceId },
    include: { connectedAccount: true },
  });

  if (!post) {
    return NextResponse.json(
      { success: false, error: "Scheduled post not found" },
      { status: 404 }
    );
  }

  const platform = post.connectedAccount.platform;
  const policy = getEditPolicy(post.status, platform);

  if (policy.editable.length === 0) {
    return NextResponse.json(
      { success: false, error: policy.reason ?? "This post cannot be edited" },
      { status: 409 }
    );
  }

  const body = parsed.data;
  const requested: EditableField[] = [];
  if (body.caption !== undefined) requested.push("caption");
  if (body.scheduledAt !== undefined) requested.push("scheduledAt");
  if (body.platformOptions !== undefined) requested.push("platformOptions");
  if (body.mediaType !== undefined) requested.push("mediaType");
  if (body.mediaStorageKey !== undefined) requested.push("media");

  const rejected = rejectedFields(policy, requested);
  if (rejected.length > 0) {
    return NextResponse.json(
      {
        success: false,
        error: `${policy.reason ?? "Some fields cannot be changed"} (blocked: ${rejected.join(", ")})`,
      },
      { status: 409 }
    );
  }

  const scheduledAt = body.scheduledAt
    ? new Date(body.scheduledAt)
    : post.scheduledAt;
  const mediaType = body.mediaType ?? post.mediaType;

  if (!MEDIA_TYPE_BY_PLATFORM[platform].includes(mediaType)) {
    return NextResponse.json(
      { success: false, error: `${mediaType} is not valid for this platform` },
      { status: 400 }
    );
  }

  // Re-validate the window on every save — a post scheduled for tomorrow that
  // the user edits next week must not slip past the platform's minimum.
  const windowIssue = validateScheduleWindow(platform, scheduledAt);
  if (windowIssue) {
    return NextResponse.json(
      { success: false, error: windowIssue.message },
      { status: 400 }
    );
  }

  // New file: trust storage for the real size, not the client.
  let mediaSizeBytes = post.mediaSizeBytes;
  let mediaMimeType = post.mediaMimeType;
  if (body.mediaStorageKey && body.mediaMimeType) {
    try {
      const stat = await getMediaStorage().stat(body.mediaStorageKey);
      mediaSizeBytes = BigInt(stat.size);
      mediaMimeType = body.mediaMimeType;
    } catch {
      return NextResponse.json(
        { success: false, error: "Uploaded media not found — upload it again" },
        { status: 400 }
      );
    }

    const mediaIssue = validateMediaForPlatform(platform, {
      mimeType: mediaMimeType,
      sizeBytes: Number(mediaSizeBytes),
    });
    if (mediaIssue) {
      return NextResponse.json(
        { success: false, error: mediaIssue },
        { status: 400 }
      );
    }
  }

  const updates = {
    caption: body.caption ?? post.caption,
    scheduledAt,
    mediaType,
    platformOptions: (body.platformOptions ??
      post.platformOptions ??
      {}) as object,
    mediaStorageKey: body.mediaStorageKey ?? post.mediaStorageKey,
    mediaMimeType,
    mediaSizeBytes,
  };

  // Tell the platform BEFORE committing, when it already holds the post. On
  // failure nothing changes, so the dashboard keeps describing reality.
  if (policy.requiresPlatformSync) {
    const adapter = getAdapter(platform);
    if (!adapter.update) {
      return NextResponse.json(
        {
          success: false,
          error:
            "This platform cannot edit an already-scheduled post. Cancel it and schedule a new one.",
        },
        { status: 409 }
      );
    }

    try {
      await adapter.update({ ...post, ...updates }, post.connectedAccount);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json(
        {
          success: false,
          error: `${platform} rejected the change: ${message}. Nothing was altered — the post will publish as originally scheduled.`,
        },
        { status: 502 }
      );
    }
  }

  const previousMediaKey = post.mediaStorageKey;
  const updated = await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      ...updates,
      // A failed post that has been edited deserves a clean slate.
      ...(post.status === "FAILED" || post.status === "CANCELED"
        ? { status: "QUEUED" as const, lastError: null, attemptCount: 0 }
        : {}),
    },
  });

  await prisma.publishJobLog.create({
    data: {
      scheduledPostId: post.id,
      attempt: post.attemptCount,
      status: "EDITED",
      responseSnippet: `Changed: ${requested.join(", ")}`,
    },
  });

  // Only bin the old file once nothing else points at it. Fan-out siblings
  // share a mediaStorageKey, so deleting eagerly would break the other posts in
  // the batch.
  if (body.mediaStorageKey && body.mediaStorageKey !== previousMediaKey) {
    const stillReferenced = await prisma.scheduledPost.count({
      where: { mediaStorageKey: previousMediaKey },
    });
    if (stillReferenced === 0) {
      await getMediaStorage()
        .delete(previousMediaKey)
        .catch(() => {});
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      ...updated,
      mediaSizeBytes: Number(updated.mediaSizeBytes),
      syncedToPlatform: policy.requiresPlatformSync,
    },
  });
}

/**
 * Retry or cancel a scheduled post.
 *
 * Cancel is the interesting one. For a natively-scheduled post the platform
 * already holds the timer, so flipping our row to CANCELED would leave Facebook
 * or YouTube to publish anyway — the platform has to be told. If that call
 * fails we say so rather than reporting a cancellation that did not happen.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

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

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "action must be 'retry' or 'cancel'" },
      { status: 400 }
    );
  }

  const post = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId: context.workspaceId },
    include: { connectedAccount: true },
  });

  if (!post) {
    return NextResponse.json(
      { success: false, error: "Scheduled post not found" },
      { status: 404 }
    );
  }

  if (parsed.data.action === "cancel") {
    if (post.status === "PUBLISHED") {
      return NextResponse.json(
        {
          success: false,
          error: "This post is already live — delete it on the platform itself",
        },
        { status: 409 }
      );
    }

    const adapter = getAdapter(post.connectedAccount.platform);

    // Only meaningful once the platform has actually taken the post.
    if (post.status === "SCHEDULED_REMOTE" && adapter.cancel) {
      try {
        await adapter.cancel(post, post.connectedAccount);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        // Facebook documents no cancel path for Reels at all, so this can
        // genuinely fail. Leave the row alone and tell the user the truth.
        return NextResponse.json(
          {
            success: false,
            error: `Could not cancel this on ${post.connectedAccount.platform}: ${message}. It may still publish — check the platform directly.`,
          },
          { status: 502 }
        );
      }
    }

    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { status: "CANCELED", lastError: null },
    });

    // Drop any queued job so the worker does not process a cancelled post.
    await getPublishQueue()
      .remove(`publish_${post.id}`)
      .catch(() => {});

    return NextResponse.json({ success: true, data: { status: "CANCELED" } });
  }

  // ─── retry ───────────────────────────────────────────────────────────────

  if (post.status !== "FAILED" && post.status !== "CANCELED") {
    return NextResponse.json(
      { success: false, error: "Only failed or cancelled posts can be retried" },
      { status: 409 }
    );
  }

  if (post.connectedAccount.status !== "ACTIVE") {
    return NextResponse.json(
      {
        success: false,
        error: "Reconnect this account before retrying",
      },
      { status: 409 }
    );
  }

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "QUEUED", lastError: null, attemptCount: 0 },
  });

  // A retry publishes now, whatever the original time was — the scheduled
  // moment has passed and the user asked for it explicitly. Enqueued rather
  // than run inline so a large re-upload does not hold the request open.
  await getPublishQueue().add(
    "publish-post",
    { scheduledPostId: post.id },
    { jobId: `publish_${post.id}_retry_${Date.now()}` }
  );

  return NextResponse.json({ success: true, data: { status: "QUEUED" } });
}

/** Remove a post record entirely. Cancels first if it is still pending. */
export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

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

  const post = await prisma.scheduledPost.findFirst({
    where: { id, workspaceId: context.workspaceId },
    select: { id: true, status: true },
  });

  if (!post) {
    return NextResponse.json(
      { success: false, error: "Scheduled post not found" },
      { status: 404 }
    );
  }

  if (post.status === "SCHEDULED_REMOTE") {
    return NextResponse.json(
      {
        success: false,
        error: "Cancel this first — the platform is still holding it",
      },
      { status: 409 }
    );
  }

  await getPublishQueue()
    .remove(`publish_${post.id}`)
    .catch(() => {});
  await prisma.scheduledPost.delete({ where: { id: post.id } });

  return NextResponse.json({ success: true });
}
