import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getPublishQueue } from "@/lib/queue/client";
import { getAdapter } from "@/lib/scheduler/adapters";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const actionSchema = z.object({ action: z.enum(["retry", "cancel"]) });

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
