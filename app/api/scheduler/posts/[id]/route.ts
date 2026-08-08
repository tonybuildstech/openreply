import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type {
  ScheduledPostMedia,
  ScheduledPostMediaKind,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getPublishQueue } from "@/lib/queue/client";
import { getAdapter } from "@/lib/scheduler/adapters";
import {
  PLATFORM_CONSTRAINTS,
  validateCaptionForPlatform,
  validateMediaForPlatform,
  validateScheduleWindow,
} from "@/lib/scheduler/constraints";
import {
  getEditPolicy,
  rejectedFields,
  type EditableField,
} from "@/lib/scheduler/editing";
import {
  mediaItemSchema,
  normaliseUserTags,
  type MediaUserTagInput,
} from "@/lib/scheduler/media-input";
import {
  MAX_MEDIA_ITEMS,
  MEDIA_TYPE_BY_PLATFORM,
  SCHEDULED_POST_TYPES,
} from "@/lib/scheduler/types";
import { getMediaStorage, mediaKindFor } from "@/lib/storage";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const actionSchema = z.object({ action: z.enum(["retry", "cancel"]) });

const patchSchema = z.object({
  caption: z.string().max(5000).optional(),
  scheduledAt: z.string().datetime().optional(),
  mediaType: z.enum(SCHEDULED_POST_TYPES).optional(),
  platformOptions: z.record(z.string(), z.unknown()).optional(),
  /**
   * Replaces the WHOLE ordered set, not a single item. Swapping files requires
   * a fresh upload first; the client sends the new keys from /api/media/upload.
   * Partial edits are not offered on purpose — positions must stay contiguous,
   * and "replace everything" is the only operation that cannot leave a gap.
   */
  media: z.array(mediaItemSchema).min(1).max(MAX_MEDIA_ITEMS).optional(),
});

interface NewMediaItem {
  position: number;
  storageKey: string;
  mimeType: string;
  sizeBytes: bigint;
  kind: ScheduledPostMediaKind;
  widthPx: number | null;
  heightPx: number | null;
  durationMs: number | null;
  croppedToRatio: string | null;
  /** Omitted rather than nulled — see the note in the create route. */
  userTags: MediaUserTagInput[] | undefined;
}

/** BigInt does not survive JSON.stringify, and every item carries one. */
function serialiseMedia(media: ScheduledPostMedia[]) {
  return media.map((item) => ({
    ...item,
    sizeBytes: Number(item.sizeBytes),
  }));
}

/**
 * Bin stored files that no post references any more.
 *
 * The reference count is what makes this safe: one composer submission fans out
 * to N posts that all point at the SAME storage key, so deleting eagerly when
 * one of them changes would break its siblings. Called after the row change has
 * committed, so the count reflects reality.
 *
 * Failures are swallowed — an orphaned file wastes disk, but a 500 here would
 * fail an edit or delete that already succeeded.
 */
async function deleteOrphanedMedia(keys: string[]): Promise<void> {
  const storage = getMediaStorage();

  for (const key of new Set(keys)) {
    const stillReferenced = await prisma.scheduledPostMedia.count({
      where: { storageKey: key },
    });
    if (stillReferenced === 0) {
      await storage.delete(key).catch(() => {});
    }
  }
}

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
      media: { orderBy: { position: "asc" } },
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
      media: serialiseMedia(post.media),
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
    include: {
      connectedAccount: true,
      media: { orderBy: { position: "asc" } },
    },
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
  if (body.media !== undefined) requested.push("media");

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

  // Against the caption this save would leave in place, not just a supplied
  // one — the same check the create route runs, because a rule enforced on
  // create and not on edit is worse than no rule.
  const captionIssue = validateCaptionForPlatform(
    platform,
    body.caption ?? post.caption
  );
  if (captionIssue) {
    return NextResponse.json(
      { success: false, error: captionIssue },
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

  // New files: trust storage for size, MIME type and kind, never the client.
  let replacementMedia: NewMediaItem[] | null = null;
  if (body.media) {
    const storage = getMediaStorage();
    const items: NewMediaItem[] = [];

    for (const [index, item] of body.media.entries()) {
      let stat: { size: number; contentType: string };
      try {
        stat = await storage.stat(item.storageKey);
      } catch {
        return NextResponse.json(
          {
            success: false,
            error:
              body.media.length > 1
                ? `Item ${index + 1} was not found in storage — upload it again`
                : "Uploaded media not found — upload it again",
          },
          { status: 400 }
        );
      }

      items.push({
        // Array order, not a client-supplied position.
        position: index,
        storageKey: item.storageKey,
        mimeType: stat.contentType,
        sizeBytes: BigInt(stat.size),
        kind: mediaKindFor(stat.contentType),
        widthPx: item.widthPx ?? null,
        heightPx: item.heightPx ?? null,
        durationMs: item.durationMs ?? null,
        croppedToRatio: item.croppedToRatio ?? null,
        userTags: normaliseUserTags(item.userTags) ?? undefined,
      });
    }

    const mediaIssue = validateMediaForPlatform(
      platform,
      mediaType,
      items.map((item) => ({
        mimeType: item.mimeType,
        sizeBytes: Number(item.sizeBytes),
        kind: item.kind,
        widthPx: item.widthPx,
        heightPx: item.heightPx,
      }))
    );
    if (mediaIssue) {
      return NextResponse.json(
        { success: false, error: mediaIssue },
        { status: 400 }
      );
    }

    replacementMedia = items;
  }

  const updates = {
    caption: body.caption ?? post.caption,
    scheduledAt,
    mediaType,
    platformOptions: (body.platformOptions ??
      post.platformOptions ??
      {}) as object,
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
      // The adapter sees the post as it WILL be, media included — a remote
      // edit that read the old caption would push the wrong thing.
      await adapter.update(
        {
          ...post,
          ...updates,
          media: replacementMedia
            ? replacementMedia.map((item, index) => ({
                ...post.media[index],
                ...item,
                // The write path omits this field to leave the column NULL;
                // the adapter reads a row, where absent IS null.
                userTags: item.userTags ?? null,
              }))
            : post.media,
        },
        post.connectedAccount
      );
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

  const previousMediaKeys = post.media.map((item) => item.storageKey);
  const updated = await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      ...updates,
      // A failed post that has been edited deserves a clean slate.
      ...(post.status === "FAILED" || post.status === "CANCELED"
        ? { status: "QUEUED" as const, lastError: null, attemptCount: 0 }
        : {}),
      // Swapping the file replaces the whole ordered set rather than editing
      // rows in place: positions must stay contiguous, and deleteMany +
      // create inside one update is atomic.
      ...(replacementMedia
        ? { media: { deleteMany: {}, create: replacementMedia } }
        : {}),
    },
    include: { media: { orderBy: { position: "asc" } } },
  });

  await prisma.publishJobLog.create({
    data: {
      scheduledPostId: post.id,
      attempt: post.attemptCount,
      status: "EDITED",
      responseSnippet: `Changed: ${requested.join(", ")}`,
    },
  });

  if (replacementMedia) {
    await deleteOrphanedMedia(previousMediaKeys);
  }

  return NextResponse.json({
    success: true,
    data: {
      ...updated,
      media: serialiseMedia(updated.media),
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
    include: {
      connectedAccount: true,
      media: { orderBy: { position: "asc" } },
    },
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
    select: {
      id: true,
      status: true,
      media: { select: { storageKey: true } },
    },
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
  // Cascade takes this post's ScheduledPostMedia rows with it, which is what
  // makes the reference count below correct: it now sees only OTHER posts.
  await prisma.scheduledPost.delete({ where: { id: post.id } });

  await deleteOrphanedMedia(post.media.map((item) => item.storageKey));

  return NextResponse.json({ success: true });
}
