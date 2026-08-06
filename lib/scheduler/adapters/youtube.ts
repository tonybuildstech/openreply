/**
 * YouTube Shorts publishing — YouTube Data API v3.
 *
 * Dispatch mode: NATIVE. `status.publishAt` means YouTube holds the timer, so
 * this runs once at schedule time and the video flips itself public later.
 *
 * Two facts from research (2026-08-09) shape everything here:
 *
 *  1. `videos.insert` costs **1,600 quota units** against a 10,000/day project
 *     default — about **six uploads per day for the entire installation**. We
 *     check the budget before starting and record the spend after.
 *
 *  2. An API project that has **not passed YouTube's audit** has every upload
 *     **forced to private, permanently** — `publishAt` will not make it public.
 *     That is not an error we can catch; it is silent. So the adapter returns a
 *     notice, and the connections screen states it per channel.
 *
 * There is no "Shorts" field in the API: YouTube infers it from aspect ratio
 * and duration.
 */

import type {
  ConnectedAccount,
  ScheduledPost,
} from "@/app/generated/prisma/client";
import { fetchWithTimeout, toResponseSnippet } from "@/lib/scheduler/http";
import {
  YOUTUBE_UPDATE_UNIT_COST,
  YOUTUBE_UPLOAD_UNIT_COST,
  getYouTubeQuotaState,
  recordQuotaUsage,
} from "@/lib/scheduler/quota";
import { resolveAccessToken } from "@/lib/scheduler/tokens";
import { PublishError, type PublishAdapter } from "@/lib/scheduler/types";
import { getMediaStorage } from "@/lib/storage";

const UPLOAD_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

/**
 * 8 MB chunks. Google documents no chunk-size requirement — the "must be a
 * multiple of 256 KB" rule circulating in third-party guides is not in their
 * docs — so this is chosen purely to stay far below the worker's 250 MB cap.
 */
const CHUNK_BYTES = 8 * 1024 * 1024;

interface YouTubeOptions {
  title?: string;
  description?: string;
  categoryId?: string;
  tags?: string[];
  madeForKids?: boolean;
}

/** Metadata for a channel, cached on ConnectedAccount.metadata at connect time. */
export interface YouTubeAccountMetadata {
  /** False until the Google Cloud project passes the YouTube API audit. */
  projectAudited?: boolean;
}

async function googleRequest(
  url: string,
  init: RequestInit,
  context: string
): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url, { ...init, timeoutMs: 60_000 });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  > & { error?: { message?: string; errors?: Array<{ reason?: string }> } };

  if (!response.ok) {
    const reason = body.error?.errors?.[0]?.reason;
    const message = body.error?.message ?? `HTTP ${response.status}`;

    // quotaExceeded and uploadLimitExceeded are hard stops for the day — a
    // retry inside the same window just burns attempts.
    const permanent =
      reason === "quotaExceeded" ||
      reason === "uploadLimitExceeded" ||
      reason === "forbidden" ||
      response.status === 401 ||
      response.status === 403;

    throw new PublishError(
      `${context}: ${message}`,
      !permanent && (response.status >= 500 || response.status === 429),
      {
        needsReauth: response.status === 401,
        responseSnippet: toResponseSnippet(body),
      }
    );
  }

  return body;
}

/** Start a resumable session and return its session URI. */
async function startSession(
  post: ScheduledPost,
  account: ConnectedAccount,
  accessPlaintextToken: string,
  sizeBytes: number
): Promise<string> {
  const options = (post.platformOptions ?? {}) as YouTubeOptions;

  const metadata = {
    snippet: {
      // YouTube requires a title; fall back to the caption's first line so a
      // user who only wrote a caption still gets a sane video title.
      title:
        options.title?.trim() ||
        post.caption.split("\n")[0]?.slice(0, 100) ||
        "Untitled",
      description: options.description ?? post.caption,
      ...(options.tags?.length ? { tags: options.tags } : {}),
      categoryId: options.categoryId ?? "22",
    },
    status: {
      // publishAt REQUIRES privacyStatus=private on a never-published video.
      privacyStatus: "private",
      publishAt: post.scheduledAt.toISOString(),
      selfDeclaredMadeForKids: options.madeForKids ?? false,
    },
  };

  const response = await fetchWithTimeout(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessPlaintextToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(sizeBytes),
      "X-Upload-Content-Type": post.mediaMimeType,
    },
    body: JSON.stringify(metadata),
    timeoutMs: 60_000,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new PublishError(
      `YouTube upload session failed (HTTP ${response.status})`,
      response.status >= 500 || response.status === 429,
      {
        needsReauth: response.status === 401,
        responseSnippet: toResponseSnippet(text),
      }
    );
  }

  const sessionUri = response.headers.get("location");
  if (!sessionUri) {
    throw new PublishError(
      "YouTube did not return an upload session URI",
      true
    );
  }

  return sessionUri;
}

/**
 * Push the file in chunks, honouring the resumable protocol's 308 responses.
 *
 * On a 308 the `Range` header reports the last byte YouTube actually stored,
 * which is not necessarily the last byte we sent — so the next offset comes
 * from YouTube's answer, never from our own arithmetic. Ignoring that is how
 * uploads end up with duplicated or missing bytes.
 */
async function uploadChunks(
  post: ScheduledPost,
  sessionUri: string,
  accessPlaintextToken: string,
  sizeBytes: number
): Promise<Record<string, unknown>> {
  const storage = getMediaStorage();
  let offset = 0;

  while (offset < sizeBytes) {
    const end = Math.min(offset + CHUNK_BYTES, sizeBytes) - 1;
    const stream = storage.createReadStream(post.mediaStorageKey, {
      start: offset,
      end,
    });

    const response = await fetchWithTimeout(sessionUri, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessPlaintextToken}`,
        "Content-Length": String(end - offset + 1),
        "Content-Type": post.mediaMimeType,
        "Content-Range": `bytes ${offset}-${end}/${sizeBytes}`,
      },
      body: stream as unknown as BodyInit,
      duplex: "half",
      timeoutMs: 10 * 60_000,
    } as RequestInit & { duplex: "half"; timeoutMs: number });

    if (response.status === 308) {
      const range = response.headers.get("range");
      // "bytes=0-1048575" → resume at 1048576. No Range header means YouTube
      // stored nothing yet, so we re-send from the same offset.
      const lastByte = range ? Number(range.split("-")[1]) : NaN;
      offset = Number.isFinite(lastByte) ? lastByte + 1 : offset;
      continue;
    }

    if (response.ok) {
      return (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
    }

    const text = await response.text().catch(() => "");
    throw new PublishError(
      `YouTube chunk upload failed (HTTP ${response.status})`,
      response.status >= 500 || response.status === 429,
      { responseSnippet: toResponseSnippet(text) }
    );
  }

  throw new PublishError(
    "YouTube upload finished without returning a video",
    true
  );
}

export const youtubeAdapter: PublishAdapter = {
  platform: "YOUTUBE",
  dispatchMode: "NATIVE",

  async schedule(post: ScheduledPost, account: ConnectedAccount) {
    const quota = await getYouTubeQuotaState();
    if (!quota.canUpload) {
      // Retryable: tomorrow's UTC reset genuinely fixes this.
      throw new PublishError(
        `YouTube daily quota exhausted (${quota.used}/${quota.limit} units). Uploads cost 1,600 units each, so roughly ${Math.floor(quota.limit / YOUTUBE_UPLOAD_UNIT_COST)} are possible per day. Resets at UTC midnight.`,
        true
      );
    }

    const accessPlaintextToken = await resolveAccessToken(account);
    const storage = getMediaStorage();
    const { size } = await storage.stat(post.mediaStorageKey);

    const sessionUri = await startSession(
      post,
      account,
      accessPlaintextToken,
      size
    );
    const video = await uploadChunks(
      post,
      sessionUri,
      accessPlaintextToken,
      size
    );

    await recordQuotaUsage({
      platform: "YOUTUBE",
      units: YOUTUBE_UPLOAD_UNIT_COST,
      posts: 1,
    });

    const metadata = (account.metadata ?? {}) as YouTubeAccountMetadata;
    const notice =
      metadata.projectAudited === true
        ? undefined
        : "Uploaded as private. Until this Google Cloud project passes YouTube's API audit, every API upload stays private — the scheduled time will not make it public.";

    return {
      platformPostId: video.id as string | undefined,
      containerId: video.id as string | undefined,
      scheduledRemotely: true,
      notice,
    };
  },

  async checkStatus(post: ScheduledPost, account: ConnectedAccount) {
    if (!post.platformPostId) return "pending";

    const accessPlaintextToken = await resolveAccessToken(account);
    const body = await googleRequest(
      `${VIDEOS_URL}?part=status&id=${encodeURIComponent(post.platformPostId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessPlaintextToken}` },
      },
      "YouTube status check"
    );

    const item = (
      body.items as Array<{
        status?: { uploadStatus?: string; privacyStatus?: string };
      }>
    )?.[0];
    if (!item) return "failed";

    if (item.status?.uploadStatus === "rejected") return "failed";
    // "public" only arrives once publishAt has fired (and the project is
    // audited). Anything else is still waiting.
    return item.status?.privacyStatus === "private" ? "pending" : "published";
  },

  async cancel(post: ScheduledPost, account: ConnectedAccount) {
    if (!post.platformPostId) return;

    const accessPlaintextToken = await resolveAccessToken(account);

    // There is no "unschedule" field. Clearing publishAt while keeping the
    // video private is what cancelling means here — the video stays in the
    // channel as a private draft rather than vanishing.
    await googleRequest(
      `${VIDEOS_URL}?part=status`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessPlaintextToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: post.platformPostId,
          status: { privacyStatus: "private" },
        }),
      },
      "YouTube cancel"
    );

    await recordQuotaUsage({
      platform: "YOUTUBE",
      units: YOUTUBE_UPDATE_UNIT_COST,
    });
  },
};
