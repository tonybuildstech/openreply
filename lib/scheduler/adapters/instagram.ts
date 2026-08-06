/**
 * Instagram Reels publishing — Instagram API with Instagram Login.
 *
 * Dispatch mode: QUEUED. Instagram has no scheduling parameter of any kind
 * (confirmed against Meta's technical reference — the "schedule posts" claim on
 * Meta's product marketing page applies to other flows). Our worker fires this
 * at the scheduled minute.
 *
 * Flow (research 2026-08-06):
 *   1. POST graph.instagram.com/{v}/{ig-user-id}/media
 *        ?media_type=REELS&upload_type=resumable          → container id
 *   2. POST rupload.facebook.com/ig-api-upload/{v}/{container-id}
 *        Authorization: OAuth <token>, offset, file_size  → raw bytes
 *   3. GET  graph.instagram.com/{v}/{container-id}?fields=status_code
 *        poll until FINISHED
 *   4. POST graph.instagram.com/{v}/{ig-user-id}/media_publish
 *        creation_id=<container-id>                        → media id
 *
 * Requires `instagram_business_content_publish` — a separate App Review from
 * the messaging scopes this app already holds.
 */

import type {
  ConnectedAccount,
  ScheduledPost,
} from "@/app/generated/prisma/client";
import { getMetaGraphApiVersion } from "@/lib/env";
import {
  fetchWithTimeout,
  logMetaUsageHeaders,
  toResponseSnippet,
} from "@/lib/scheduler/http";
import { getMediaStorage } from "@/lib/storage";
import { resolveAccessToken } from "@/lib/scheduler/tokens";
import { PublishError, type PublishAdapter } from "@/lib/scheduler/types";

const CONTAINER_POLL_INTERVAL_MS = 6_000;
// Meta documents no processing SLA. Ten minutes is our own ceiling: long enough
// for a 90-second Reel, short enough that a stuck container frees the worker.
const CONTAINER_POLL_TIMEOUT_MS = 10 * 60_000;

function graphBase(): string {
  return `https://graph.instagram.com/${getMetaGraphApiVersion()}`;
}

function ruploadBase(): string {
  return `https://rupload.facebook.com/ig-api-upload/${getMetaGraphApiVersion()}`;
}

interface InstagramOptions {
  shareToFeed?: boolean;
  coverUrl?: string;
  thumbOffset?: number;
  audioName?: string;
  collaborators?: string;
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number };
}

/**
 * Meta error codes worth retrying. 190 (bad token) and 200/100 (permissions,
 * invalid parameter) are permanent; 1/2 are transient platform errors; 4/17/32
 * and 613 are throttles.
 */
function isRetryableMetaCode(code: number | undefined): boolean {
  if (code === undefined) return false;
  return [1, 2, 4, 17, 32, 341, 613].includes(code);
}

async function metaRequest(
  url: string,
  init: RequestInit,
  context: string
): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url, { ...init, timeoutMs: 60_000 });
  logMetaUsageHeaders(context, response);

  const body = (await response.json().catch(() => ({}))) as MetaErrorBody &
    Record<string, unknown>;

  if (!response.ok || body.error) {
    const code = body.error?.code;
    const message = body.error?.message ?? `HTTP ${response.status}`;

    throw new PublishError(
      `${context}: ${message}`,
      isRetryableMetaCode(code) || response.status >= 500,
      {
        needsReauth: code === 190,
        responseSnippet: toResponseSnippet(body),
      }
    );
  }

  return body;
}

/**
 * Instagram's own view of the account's rolling-24h publish budget. We ask
 * rather than hardcode, because Meta's documented cap has moved and their docs
 * have disagreed with each other about it.
 */
async function assertPublishingHeadroom(
  igUserId: string,
  accessPlaintextToken: string
): Promise<void> {
  const url =
    `${graphBase()}/${igUserId}/content_publishing_limit` +
    `?fields=quota_usage,quota_limit&access_token=${encodeURIComponent(accessPlaintextToken)}`;

  let body: Record<string, unknown>;
  try {
    body = await metaRequest(url, { method: "GET" }, "Instagram quota check");
  } catch {
    // A failing pre-flight check must not block publishing — the publish call
    // enforces the real limit anyway and will tell us plainly if we exceed it.
    return;
  }

  const row = (body.data as Array<{ quota_usage?: number; quota_limit?: number }>)?.[0];
  if (!row) return;

  const usage = row.quota_usage ?? 0;
  const limit = row.quota_limit ?? 25;

  if (usage >= limit) {
    // Requeue-worthy: the window rolls forward, so this genuinely succeeds later.
    throw new PublishError(
      `Instagram publishing limit reached (${usage}/${limit} in the last 24 hours)`,
      true
    );
  }
}

async function createContainer(
  post: ScheduledPost,
  igUserId: string,
  accessPlaintextToken: string
): Promise<string> {
  const options = (post.platformOptions ?? {}) as InstagramOptions;

  const params = new URLSearchParams({
    media_type: "REELS",
    upload_type: "resumable",
    access_token: accessPlaintextToken,
  });
  if (post.caption) params.set("caption", post.caption);
  if (options.shareToFeed !== undefined) {
    params.set("share_to_feed", String(options.shareToFeed));
  }
  if (options.coverUrl) params.set("cover_url", options.coverUrl);
  if (options.thumbOffset !== undefined) {
    params.set("thumb_offset", String(options.thumbOffset));
  }
  if (options.audioName) params.set("audio_name", options.audioName);
  if (options.collaborators) {
    params.set("collaborators", options.collaborators);
  }

  const body = await metaRequest(
    `${graphBase()}/${igUserId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    "Instagram container creation"
  );

  const containerId = body.id as string | undefined;
  if (!containerId) {
    throw new PublishError(
      "Instagram did not return a container ID",
      true,
      { responseSnippet: toResponseSnippet(body) }
    );
  }

  return containerId;
}

async function uploadBinary(
  post: ScheduledPost,
  containerId: string,
  accessPlaintextToken: string
): Promise<void> {
  const storage = getMediaStorage();
  const { size } = await storage.stat(post.mediaStorageKey);

  // Streamed from disk — the worker runs under a 250 MB RSS cap and these
  // files can be a gigabyte.
  const stream = storage.createReadStream(post.mediaStorageKey);

  const response = await fetchWithTimeout(`${ruploadBase()}/${containerId}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessPlaintextToken}`,
      offset: "0",
      // Documented alongside `offset` for the Reels rupload flow. Meta's IG
      // reference is truncated here, so this one is verify-on-first-run.
      file_size: String(size),
      "Content-Type": "application/octet-stream",
    },
    body: stream as unknown as BodyInit,
    // Node requires this when streaming a request body.
    duplex: "half",
    timeoutMs: 30 * 60_000,
  } as RequestInit & { duplex: "half"; timeoutMs: number });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new PublishError(
      `Instagram upload failed (HTTP ${response.status})`,
      response.status >= 500 || response.status === 429,
      { responseSnippet: toResponseSnippet(text) }
    );
  }
}

async function waitForContainer(
  containerId: string,
  accessPlaintextToken: string
): Promise<void> {
  const deadline = Date.now() + CONTAINER_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const body = await metaRequest(
      `${graphBase()}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessPlaintextToken)}`,
      { method: "GET" },
      "Instagram container status"
    );

    const status = body.status_code as string | undefined;

    if (status === "FINISHED") return;

    if (status === "ERROR") {
      // Documented as terminal. The container cannot be reused; a retry must
      // start from a fresh container, which is what the worker's retry does.
      throw new PublishError(
        "Instagram could not process this video. Check that it meets Reels requirements (MP4, 3–90s, vertical).",
        false,
        { responseSnippet: toResponseSnippet(body) }
      );
    }

    // Only IN_PROGRESS / FINISHED / ERROR are documented. Anything else (an
    // EXPIRED, say) is treated as terminal-unknown rather than assumed
    // recoverable — silently retrying a stale container is exactly the failure
    // mode the brief warned about.
    if (status && status !== "IN_PROGRESS") {
      throw new PublishError(
        `Instagram returned an unexpected container status: ${status}`,
        false,
        { responseSnippet: toResponseSnippet(body) }
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS)
    );
  }

  throw new PublishError(
    "Instagram is still processing this video after 10 minutes",
    true
  );
}

export const instagramAdapter: PublishAdapter = {
  platform: "INSTAGRAM",
  dispatchMode: "QUEUED",

  async schedule(post: ScheduledPost, account: ConnectedAccount) {
    const accessPlaintextToken = await resolveAccessToken(account);
    const igUserId = account.platformAccountId;

    await assertPublishingHeadroom(igUserId, accessPlaintextToken);

    const containerId = await createContainer(
      post,
      igUserId,
      accessPlaintextToken
    );
    await uploadBinary(post, containerId, accessPlaintextToken);
    await waitForContainer(containerId, accessPlaintextToken);

    const published = await metaRequest(
      `${graphBase()}/${igUserId}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          creation_id: containerId,
          access_token: accessPlaintextToken,
        }).toString(),
      },
      "Instagram publish"
    );

    return {
      platformPostId: published.id as string | undefined,
      containerId,
    };
  },
};
