/**
 * Facebook Page video + Reels publishing.
 *
 * Dispatch mode: NATIVE — for BOTH post types. The open question going in was
 * whether Page Reels support scheduling; research (2026-08-06) confirmed they
 * do, via `video_state=SCHEDULED` + `scheduled_publish_time` on the
 * `video_reels` edge. So Facebook never touches the worker queue.
 *
 * Reels          POST /{page-id}/video_reels  upload_phase=start   → video_id + upload_url
 *                POST rupload.facebook.com/video-upload/{video-id} → raw bytes
 *                POST /{page-id}/video_reels  upload_phase=finish  → SCHEDULED
 *
 * Feed video     POST /{app-id}/uploads                            → upload session
 *                POST /upload:{session-id}                         → raw bytes → handle
 *                POST /{page-id}/videos  published=false + scheduled_publish_time
 *
 * All uploads go to `graph.facebook.com`. `graph-video.facebook.com` is
 * deprecated — older examples still show it and must not be copied.
 */

import type {
  ConnectedAccount,
  ScheduledPost,
} from "@/app/generated/prisma/client";
import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";
import {
  fetchWithTimeout,
  logMetaUsageHeaders,
  toResponseSnippet,
} from "@/lib/scheduler/http";
import { recordQuotaUsage } from "@/lib/scheduler/quota";
import { resolveAccessToken } from "@/lib/scheduler/tokens";
import { PublishError, type PublishAdapter } from "@/lib/scheduler/types";
import { getMediaStorage } from "@/lib/storage";

function graphBase(): string {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

interface FacebookOptions {
  title?: string;
}

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

  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number };
  } & Record<string, unknown>;

  if (!response.ok || body.error) {
    const code = body.error?.code;
    throw new PublishError(
      `${context}: ${body.error?.message ?? `HTTP ${response.status}`}`,
      isRetryableMetaCode(code) || response.status >= 500,
      {
        needsReauth: code === 190,
        responseSnippet: toResponseSnippet(body),
      }
    );
  }

  return body;
}

/** Unix seconds — what `scheduled_publish_time` expects. */
function toUnixSeconds(date: Date): string {
  return String(Math.floor(date.getTime() / 1000));
}

// ─── Reels ──────────────────────────────────────────────────────────────────

async function publishReel(
  post: ScheduledPost,
  account: ConnectedAccount,
  accessPlaintextToken: string
) {
  const pageId = account.platformAccountId;

  const start = await metaRequest(
    `${graphBase()}/${pageId}/video_reels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "start",
        access_token: accessPlaintextToken,
      }),
    },
    "Facebook Reel upload start"
  );

  const videoId = start.video_id as string | undefined;
  const uploadUrl = start.upload_url as string | undefined;
  if (!videoId || !uploadUrl) {
    throw new PublishError(
      "Facebook did not return a Reels upload session",
      true,
      { responseSnippet: toResponseSnippet(start) }
    );
  }

  const storage = getMediaStorage();
  const { size } = await storage.stat(post.mediaStorageKey);
  const stream = storage.createReadStream(post.mediaStorageKey);

  const uploadResponse = await fetchWithTimeout(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessPlaintextToken}`,
      offset: "0",
      file_size: String(size),
      "Content-Type": "application/octet-stream",
    },
    body: stream as unknown as BodyInit,
    duplex: "half",
    timeoutMs: 30 * 60_000,
  } as RequestInit & { duplex: "half"; timeoutMs: number });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => "");
    throw new PublishError(
      `Facebook Reel upload failed (HTTP ${uploadResponse.status})`,
      uploadResponse.status >= 500 || uploadResponse.status === 429,
      { responseSnippet: toResponseSnippet(text) }
    );
  }

  await metaRequest(
    `${graphBase()}/${pageId}/video_reels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_token: accessPlaintextToken,
        video_id: videoId,
        upload_phase: "finish",
        video_state: "SCHEDULED",
        scheduled_publish_time: toUnixSeconds(post.scheduledAt),
        description: post.caption,
      }).toString(),
    },
    "Facebook Reel schedule"
  );

  return { videoId };
}

// ─── Feed video ─────────────────────────────────────────────────────────────

async function publishFeedVideo(
  post: ScheduledPost,
  account: ConnectedAccount,
  accessPlaintextToken: string
) {
  const pageId = account.platformAccountId;
  const appId = requireEnv("FACEBOOK_APP_ID");
  const storage = getMediaStorage();
  const { size } = await storage.stat(post.mediaStorageKey);

  const session = await metaRequest(
    `${graphBase()}/${appId}/uploads?` +
      new URLSearchParams({
        file_name: post.mediaStorageKey.split("/").pop() ?? "video.mp4",
        file_length: String(size),
        file_type: post.mediaMimeType,
        access_token: accessPlaintextToken,
      }).toString(),
    { method: "POST" },
    "Facebook upload session"
  );

  const sessionId = session.id as string | undefined;
  if (!sessionId) {
    throw new PublishError(
      "Facebook did not return an upload session",
      true,
      { responseSnippet: toResponseSnippet(session) }
    );
  }

  const stream = storage.createReadStream(post.mediaStorageKey);
  const transfer = await fetchWithTimeout(`${graphBase()}/${sessionId}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessPlaintextToken}`,
      file_offset: "0",
    },
    body: stream as unknown as BodyInit,
    duplex: "half",
    timeoutMs: 30 * 60_000,
  } as RequestInit & { duplex: "half"; timeoutMs: number });

  if (!transfer.ok) {
    const text = await transfer.text().catch(() => "");
    throw new PublishError(
      `Facebook video transfer failed (HTTP ${transfer.status})`,
      transfer.status >= 500 || transfer.status === 429,
      { responseSnippet: toResponseSnippet(text) }
    );
  }

  const transferBody = (await transfer.json().catch(() => ({}))) as {
    h?: string;
  };
  if (!transferBody.h) {
    throw new PublishError(
      "Facebook did not return an uploaded file handle",
      true
    );
  }

  const options = (post.platformOptions ?? {}) as FacebookOptions;
  const published = await metaRequest(
    `${graphBase()}/${pageId}/videos`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_token: accessPlaintextToken,
        fbuploader_video_file_chunk: transferBody.h,
        description: post.caption,
        ...(options.title ? { title: options.title } : {}),
        published: "false",
        scheduled_publish_time: toUnixSeconds(post.scheduledAt),
      }).toString(),
    },
    "Facebook video schedule"
  );

  return { videoId: published.id as string | undefined };
}

export const facebookAdapter: PublishAdapter = {
  platform: "FACEBOOK_PAGE",
  dispatchMode: "NATIVE",

  async schedule(post: ScheduledPost, account: ConnectedAccount) {
    const accessPlaintextToken = await resolveAccessToken(account);

    const { videoId } =
      post.mediaType === "FACEBOOK_REEL"
        ? await publishReel(post, account, accessPlaintextToken)
        : await publishFeedVideo(post, account, accessPlaintextToken);

    if (post.mediaType === "FACEBOOK_REEL") {
      // Documented hard cap: 30 API-published Reels per rolling 24 hours,
      // separate from general Page rate limits.
      await recordQuotaUsage({
        platform: "FACEBOOK_PAGE",
        connectedAccountId: account.id,
        posts: 1,
      });
    }

    return {
      platformPostId: videoId,
      containerId: videoId,
      scheduledRemotely: true,
    };
  },

  /**
   * Edit a post Facebook is already holding.
   *
   * Meta documents that scheduled posts are updated via `POST /{post-id}` — but
   * it never enumerates which fields are editable for a scheduled *video*, and
   * for Reels it documents editing not at all. So this is a best-effort call
   * against an unconfirmed surface. It throws on failure rather than swallowing
   * the error, so the caller leaves our row untouched instead of recording an
   * edit Facebook never accepted.
   */
  async update(post: ScheduledPost, account: ConnectedAccount) {
    if (!post.platformPostId) {
      throw new PublishError(
        "This Facebook post has no ID recorded, so it cannot be edited",
        false
      );
    }

    const accessPlaintextToken = await resolveAccessToken(account);
    const options = (post.platformOptions ?? {}) as FacebookOptions;

    await metaRequest(
      `${graphBase()}/${post.platformPostId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          access_token: accessPlaintextToken,
          description: post.caption,
          ...(options.title ? { title: options.title } : {}),
          scheduled_publish_time: toUnixSeconds(post.scheduledAt),
        }).toString(),
      },
      "Facebook edit"
    );
  },

  async cancel(post: ScheduledPost, account: ConnectedAccount) {
    if (!post.platformPostId) return;

    const accessPlaintextToken = await resolveAccessToken(account);

    // Meta documents DELETE /{post-id} for scheduled feed posts. For Reels it
    // documents nothing at all — cancel and reschedule are simply absent from
    // the Reels reference. We attempt the same call and let the worker surface
    // a failure rather than reporting a cancel that may not have happened.
    await metaRequest(
      `${graphBase()}/${post.platformPostId}?access_token=${encodeURIComponent(accessPlaintextToken)}`,
      { method: "DELETE" },
      "Facebook cancel"
    );
  },
};
