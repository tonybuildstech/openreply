/**
 * BullMQ consumer for scheduled publishing, plus the fire-time poll that feeds
 * it.
 *
 * Only Instagram and TikTok reach this worker: they are the platforms with no
 * scheduling API. Facebook and YouTube were dispatched at schedule time and the
 * platform holds their timer, so they are never polled here.
 */

import { Worker } from "bullmq";
import {
  PUBLISH_QUEUE_NAME,
  getPublishQueue,
  getRedisConnection,
  type PublishPostJob,
} from "@/lib/queue/client";
import { prisma } from "@/lib/db/client";
import { NATIVE_PLATFORMS, QUEUED_PLATFORMS } from "@/lib/scheduler/adapters";
import { dispatchScheduledPost } from "@/lib/scheduler/dispatch";

// Videos are large and platform uploads are slow; two at a time keeps the
// worker inside its 250 MB PM2 memory cap with room to spare.
const PUBLISH_CONCURRENCY = 2;

export function createPublishWorker(): Worker<PublishPostJob> {
  const worker = new Worker<PublishPostJob>(
    PUBLISH_QUEUE_NAME,
    async (job) => {
      const { scheduledPostId } = job.data;
      console.log(`[Publish Worker] Processing post ${scheduledPostId}`);

      // Rethrows retryable failures so BullMQ applies its backoff; terminal
      // failures are already recorded as FAILED and return normally.
      const outcome = await dispatchScheduledPost(scheduledPostId);

      console.log(
        `[Publish Worker] Post ${scheduledPostId} → ${outcome.status}`
      );
      return outcome;
    },
    {
      connection: getRedisConnection(),
      concurrency: PUBLISH_CONCURRENCY,
      // Uploads can legitimately run for many minutes; without this BullMQ
      // would consider the job stalled and hand it to a second consumer,
      // publishing the same video twice.
      lockDuration: 15 * 60_000,
    }
  );

  worker.on("failed", (job, error) => {
    console.error(
      `[Publish Worker] Job ${job?.id} failed:`,
      error instanceof Error ? error.message : error
    );
  });

  return worker;
}

/**
 * Enqueue everything that needs work, on two different rules:
 *
 *  - **QUEUED platforms** (Instagram, TikTok) once `scheduledAt` has passed —
 *    they publish at the scheduled minute, so uploading early is pointless and
 *    would burn TikTok's one-hour upload window.
 *  - **NATIVE platforms** (Facebook, YouTube) as soon as they exist, whatever
 *    their scheduled time — the platform needs the bytes up front in order to
 *    hold the timer.
 *
 * The API already enqueues native posts on creation; this is the safety net
 * that catches ones created while the worker was down. The job ID is derived
 * from the post ID, so neither path can enqueue the same post twice.
 */
export async function enqueueDuePosts(): Promise<number> {
  const due = await prisma.scheduledPost.findMany({
    where: {
      status: "QUEUED",
      connectedAccount: { status: "ACTIVE" },
      OR: [
        {
          scheduledAt: { lte: new Date() },
          connectedAccount: { platform: { in: QUEUED_PLATFORMS } },
        },
        {
          connectedAccount: { platform: { in: NATIVE_PLATFORMS } },
        },
      ],
    },
    select: { id: true },
    // A backlog (worker downtime, say) drains steadily instead of flooding
    // every platform's rate limit at once.
    take: 25,
    orderBy: { scheduledAt: "asc" },
  });

  if (due.length === 0) return 0;

  const queue = getPublishQueue();
  await Promise.all(
    due.map((post) =>
      queue.add(
        "publish-post",
        { scheduledPostId: post.id },
        { jobId: `publish_${post.id}` }
      )
    )
  );

  console.log(`[Publish Poll] Enqueued ${due.length} due post(s)`);
  return due.length;
}

/**
 * Confirm posts the platform is still processing.
 *
 * Natively-scheduled posts (SCHEDULED_REMOTE) sit here until their time
 * arrives; this flips them to PUBLISHED once the platform says so, which is
 * what makes the dashboard's status honest rather than merely optimistic.
 */
export async function reconcileRemoteStatuses(): Promise<void> {
  const pending = await prisma.scheduledPost.findMany({
    where: {
      status: "SCHEDULED_REMOTE",
      // Only worth asking once the scheduled moment has actually passed.
      scheduledAt: { lte: new Date() },
    },
    include: { connectedAccount: true },
    take: 20,
    orderBy: { scheduledAt: "asc" },
  });

  for (const post of pending) {
    const { getAdapter } = await import("@/lib/scheduler/adapters");
    const adapter = getAdapter(post.connectedAccount.platform);
    if (!adapter.checkStatus) continue;

    try {
      const status = await adapter.checkStatus(post, post.connectedAccount);
      if (status === "pending") continue;

      await prisma.scheduledPost.update({
        where: { id: post.id },
        data:
          status === "published"
            ? { status: "PUBLISHED", publishedAt: new Date() }
            : { status: "FAILED", lastError: "The platform rejected this post" },
      });
    } catch (error) {
      // A status check is informational — never fail a post because we could
      // not confirm it. The next sweep tries again.
      console.warn(
        `[Publish Poll] Status check failed for ${post.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}
