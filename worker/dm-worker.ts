import "./bootstrap-env"; // must be first — loads .env before anything reads process.env
import { createDMWorker } from "@/lib/queue/dm-worker";
import {
  createPublishWorker,
  enqueueDuePosts,
  reconcileRemoteStatuses,
} from "@/lib/queue/publish-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import os from "node:os";

const worker = createDMWorker();
// Scheduled publishing shares this process: PM2 runs a single worker instance
// in fork mode, so a second process would need its own entry and its own slice
// of the VPS's memory budget.
const publishWorker = createPublishWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);
// How often we look for scheduled posts that have come due. One minute is the
// resolution of the scheduler — a post can publish up to this late.
const PUBLISH_POLL_INTERVAL_MS = Number(
  process.env.PUBLISH_POLL_INTERVAL_MS ?? 60_000
);

console.log("[DM Worker] Started");
console.log("[Publish Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

// The fire-time tick for Instagram and TikTok, the two platforms with no
// scheduling API. Facebook and YouTube are never polled here — their posts were
// handed over at schedule time and the platform holds the timer.
async function publishPoll() {
  try {
    await enqueueDuePosts();
    await reconcileRemoteStatuses();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Publish Worker] Poll failed:", message);
  }
}

setTimeout(() => void publishPoll(), 15_000);
const publishPollTimer = setInterval(
  () => void publishPoll(),
  PUBLISH_POLL_INTERVAL_MS
);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(publishPollTimer);
  // Both workers get a chance to finish in-flight jobs. A publish job may be
  // mid-upload, so this is not instant.
  await Promise.all([worker.close(), publishWorker.close()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
