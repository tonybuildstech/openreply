/**
 * BullMQ Queue Client
 *
 * Provides the DM processing queue and Redis connection for BullMQ.
 */

import { Queue } from "bullmq";
import Redis from "ioredis";

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // Required by BullMQ
    });
  }
  return connection;
}

// ─── DM Queue ───────────────────────────────────────────────────────────────────

export type CommentSource = "WEBHOOK" | "POLLING";

export interface ProcessCommentJob {
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  // ISO timestamp of when the comment was created, when we know it. Drives the
  // 7-day private-reply window check in the worker — see
  // lib/meta/private-reply-window.ts. Optional because jobs enqueued before
  // this field existed are still draining, and because a webhook payload
  // without a usable time should not block the send.
  commentCreatedAt?: string;
  requeueAttempt?: number;
  // Which path enqueued this comment. Recorded in the shared ProcessedComment
  // dedup store so the reconciler can tell webhook- from polling-caught comments.
  source?: CommentSource;
}

// Delivered when a user taps an opening DM's button — carries the reveal target.
export interface ProcessPostbackJob {
  instagramAccountId: string;
  userId: string;
  payload: string;
  mid?: string;
}

export type DmQueueJob = ProcessCommentJob | ProcessPostbackJob;

export const POSTBACK_JOB_NAME = "process-postback";

// ─── Publish Queue ──────────────────────────────────────────────────────────

export interface PublishPostJob {
  scheduledPostId: string;
}

export const PUBLISH_QUEUE_NAME = "publish-processing";

let publishQueue: Queue<PublishPostJob> | null = null;

/**
 * Queue for the scheduler's fire-time publishing (Instagram and TikTok, the
 * two platforms with no scheduling API). Separate from the DM queue because a
 * video upload takes minutes and must never sit behind — or hold up — the
 * latency-sensitive DM stream.
 */
export function getPublishQueue(): Queue<PublishPostJob> {
  if (!publishQueue) {
    publishQueue = new Queue<PublishPostJob>(PUBLISH_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        // Failures here are user-visible and their cause matters, so failed
        // jobs are kept far longer than the DM queue keeps its own. The real
        // record lives in PublishJobLog either way.
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
        attempts: 3,
        // 30s → 2m → 8m. Long enough for a rate-limit window to roll over,
        // short enough that a scheduled post is not hours late.
        backoff: { type: "exponential", delay: 30_000 },
      },
    });
  }
  return publishQueue;
}

let dmQueue: Queue<DmQueueJob> | null = null;

export function getDMQueue(): Queue<DmQueueJob> {
  if (!dmQueue) {
    dmQueue = new Queue<DmQueueJob>("dm-processing", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 }, // Keep last 1000 completed jobs
        // Clear failed jobs shortly after they exhaust retries. Job ids are
        // deterministic (comment_<acct>_<id>), so a retained failed job would
        // block the polling reconciler from ever retrying that comment. Clearing
        // them lets a later sweep re-enqueue and try again once a transient
        // failure (e.g. an Instagram rate-limit window) has passed. Failure
        // detail is still preserved in DmLog.
        removeOnFail: { age: 300, count: 2000 },
        attempts: 3,
        backoff: {
          type: "custom",
        },
      },
    });
  }
  return dmQueue;
}
