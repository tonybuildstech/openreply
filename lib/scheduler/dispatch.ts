/**
 * Runs one scheduled post through its adapter and records the outcome.
 *
 * Both entry points share this: the API route dispatches NATIVE platforms the
 * moment the user schedules, and the worker dispatches QUEUED platforms at the
 * scheduled minute. Keeping status transitions, logging, and error
 * classification in one place is what stops the two paths from drifting.
 */

import type { ScheduledPost } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getAdapter } from "@/lib/scheduler/adapters";
import { toResponseSnippet } from "@/lib/scheduler/http";
import { PublishError } from "@/lib/scheduler/types";

async function log(
  scheduledPostId: string,
  attempt: number,
  status: string,
  responseSnippet?: string
): Promise<void> {
  await prisma.publishJobLog.create({
    data: {
      scheduledPostId,
      attempt,
      status,
      // Scrubbed by toResponseSnippet at every call site — platform error
      // bodies echo request context and would otherwise persist a token here.
      responseSnippet: responseSnippet ?? null,
    },
  });
}

export interface DispatchOutcome {
  status: ScheduledPost["status"];
  notice?: string;
  error?: string;
}

/**
 * Publish (or natively schedule) one post.
 *
 * Never throws for a terminal failure — it records FAILED and returns. It DOES
 * rethrow retryable failures, so BullMQ can apply its backoff and try again.
 */
export async function dispatchScheduledPost(
  scheduledPostId: string
): Promise<DispatchOutcome> {
  const post = await prisma.scheduledPost.findUnique({
    where: { id: scheduledPostId },
    include: { connectedAccount: true },
  });

  if (!post) {
    return { status: "FAILED", error: "Scheduled post no longer exists" };
  }

  // A user may have cancelled between enqueue and execution — the queue holds
  // no lock on the row, so this check is what makes cancel actually work.
  if (post.status === "CANCELED") {
    return { status: "CANCELED" };
  }
  if (post.status === "PUBLISHED" || post.status === "SCHEDULED_REMOTE") {
    return { status: post.status };
  }

  const attempt = post.attemptCount + 1;
  const adapter = getAdapter(post.connectedAccount.platform);

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "UPLOADING", attemptCount: attempt, lastError: null },
  });
  await log(post.id, attempt, "UPLOADING");

  try {
    const result = await adapter.schedule(post, post.connectedAccount);

    // NATIVE platforms now hold the timer themselves; QUEUED ones just posted.
    const status: ScheduledPost["status"] = result.scheduledRemotely
      ? "SCHEDULED_REMOTE"
      : "PUBLISHED";

    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: {
        status,
        platformPostId: result.platformPostId ?? null,
        platformContainerId: result.containerId ?? null,
        publishedAt: status === "PUBLISHED" ? new Date() : null,
        lastError: result.notice ?? null,
      },
    });
    await log(post.id, attempt, status, result.notice);

    return { status, notice: result.notice };
  } catch (error) {
    const isPublishError = error instanceof PublishError;
    const retryable = isPublishError && error.retryable;
    const message =
      error instanceof Error ? error.message : "Unknown publishing error";
    const snippet = isPublishError
      ? error.options.responseSnippet
      : toResponseSnippet(error);

    if (isPublishError && error.options.needsReauth) {
      await prisma.connectedAccount.update({
        where: { id: post.connectedAccountId },
        data: { status: "NEEDS_REAUTH" },
      });
    }

    await log(
      post.id,
      attempt,
      retryable ? "RETRYING" : "FAILED",
      toResponseSnippet(snippet ?? message)
    );

    if (retryable) {
      // Back to QUEUED so a later attempt (or the poll's safety net) picks it
      // up, then rethrow to let BullMQ own the backoff.
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "QUEUED", lastError: message },
      });
      throw error;
    }

    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { status: "FAILED", lastError: message },
    });

    return { status: "FAILED", error: message };
  }
}
