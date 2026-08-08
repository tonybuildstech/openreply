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
  ScheduledPostMedia,
} from "@/app/generated/prisma/client";
import { fetchWithTimeout, toResponseSnippet } from "@/lib/scheduler/http";
import {
  YOUTUBE_UPDATE_UNIT_COST,
  YOUTUBE_UPLOAD_UNIT_COST,
  getYouTubeQuotaState,
  recordQuotaUsage,
} from "@/lib/scheduler/quota";
import { resolveAccessToken } from "@/lib/scheduler/tokens";
import {
  PublishError,
  requireSingleMedia,
  type PublishAdapter,
  type ScheduledPostWithMedia,
} from "@/lib/scheduler/types";
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

/**
 * How many consecutive chunk PUTs may store nothing before we give up.
 *
 * A 308 that reports no forward progress is legitimate transiently, so a couple
 * of re-sends are correct. Unbounded, they are not: each attempt re-uploads up
 * to 8 MB with a 10-minute timeout, so a wedged session would occupy the worker
 * until PM2's memory cap killed it — and because the worker is single-process,
 * every other scheduled post queues behind it.
 */
const MAX_STALLED_CHUNK_ATTEMPTS = 5;

/** Linear backoff between stalled re-sends: 1s, 2s, 3s, 4s. */
const STALLED_CHUNK_BACKOFF_MS = 1_000;

/**
 * Resume position from a resumable-upload 308, or null if YouTube reported
 * nothing usable.
 *
 * The header is `Range: bytes=0-262143`, where the last byte is the last one
 * YouTube actually STORED — not the last one we sent. Parsing is strict on
 * purpose: a malformed header must read as "no progress" and be retried, never
 * be coerced into a plausible-looking offset that silently corrupts the upload.
 */
export function parseResumeOffset(rangeHeader: string | null): number | null {
  const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader?.trim() ?? "");
  if (!match) return null;

  const lastByte = Number(match[2]);
  return Number.isSafeInteger(lastByte) ? lastByte + 1 : null;
}

interface YouTubeOptions {
  title?: string;
  description?: string;
  categoryId?: string;
  /** Comma-separated in the composer; the API wants an array. */
  tags?: string;
  madeForKids?: boolean;
}

export function toTagList(tags: string | undefined): string[] {
  return (tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
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
  media: ScheduledPostMedia,
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
      // The composer collects a comma-separated string; the API wants an array.
      ...(toTagList(options.tags).length
        ? { tags: toTagList(options.tags) }
        : {}),
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
      "X-Upload-Content-Type": media.mimeType,
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
  media: ScheduledPostMedia,
  sessionUri: string,
  accessPlaintextToken: string,
  sizeBytes: number
): Promise<Record<string, unknown>> {
  const storage = getMediaStorage();
  let offset = 0;
  let stalledAttempts = 0;

  while (offset < sizeBytes) {
    const end = Math.min(offset + CHUNK_BYTES, sizeBytes) - 1;
    const stream = storage.createReadStream(media.storageKey, {
      start: offset,
      end,
    });

    const response = await fetchWithTimeout(sessionUri, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessPlaintextToken}`,
        "Content-Length": String(end - offset + 1),
        "Content-Type": media.mimeType,
        "Content-Range": `bytes ${offset}-${end}/${sizeBytes}`,
      },
      body: stream as unknown as BodyInit,
      duplex: "half",
      timeoutMs: 10 * 60_000,
    } as RequestInit & { duplex: "half"; timeoutMs: number });

    if (response.status === 308) {
      const resumeAt = parseResumeOffset(response.headers.get("range"));

      // YouTube is authoritative about what it actually stored. A missing or
      // unreadable Range means nothing landed; a value below our own position
      // means it kept less than we sent and we have to rewind. Either way the
      // next offset comes from its answer, never from our arithmetic.
      const nextOffset = resumeAt ?? offset;

      if (nextOffset > offset) {
        offset = nextOffset;
        stalledAttempts = 0;
        continue;
      }

      offset = nextOffset;
      stalledAttempts += 1;

      if (stalledAttempts >= MAX_STALLED_CHUNK_ATTEMPTS) {
        // Retryable: the job restarts with a fresh upload session, which is the
        // only way out of a wedged one. It costs another 1,600 quota units, so
        // this deliberately does not retry more than a handful of times first.
        throw new PublishError(
          `YouTube upload stalled at byte ${offset} of ${sizeBytes} — ${MAX_STALLED_CHUNK_ATTEMPTS} consecutive chunks stored nothing`,
          true
        );
      }

      // Back off before re-sending; an immediate retry of an 8 MB chunk against
      // a session that just refused it wastes the VPS's bandwidth.
      await new Promise((resolve) =>
        setTimeout(resolve, STALLED_CHUNK_BACKOFF_MS * stalledAttempts)
      );
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

  async schedule(post: ScheduledPostWithMedia, account: ConnectedAccount) {
    const quota = await getYouTubeQuotaState();
    if (!quota.canUpload) {
      // Retryable: tomorrow's UTC reset genuinely fixes this.
      throw new PublishError(
        `YouTube daily quota exhausted (${quota.used}/${quota.limit} units). Uploads cost 1,600 units each, so roughly ${Math.floor(quota.limit / YOUTUBE_UPLOAD_UNIT_COST)} are possible per day. Resets at UTC midnight.`,
        true
      );
    }

    const accessPlaintextToken = await resolveAccessToken(account);
    // YouTube publishes one video per post. Throws on a carousel rather than
    // silently sending its first item.
    const media = requireSingleMedia(post);
    const storage = getMediaStorage();
    const { size } = await storage.stat(media.storageKey);

    const sessionUri = await startSession(
      post,
      media,
      account,
      accessPlaintextToken,
      size
    );
    const video = await uploadChunks(
      media,
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

  async checkStatus(post: ScheduledPostWithMedia, account: ConnectedAccount) {
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

  /**
   * Edit a video YouTube is already holding.
   *
   * Two traps here. First, `videos.update` **replaces** every part it is given,
   * so omitting a field inside `snippet` clears it — the whole snippet has to be
   * resent from our record, not just the changed field. Second, `publishAt` is
   * only accepted while the video is private and has never been published,
   * which is exactly the SCHEDULED_REMOTE state and no other.
   */
  async update(post: ScheduledPostWithMedia, account: ConnectedAccount) {
    if (!post.platformPostId) {
      throw new PublishError(
        "This YouTube video has no ID recorded, so it cannot be edited",
        false
      );
    }

    const accessPlaintextToken = await resolveAccessToken(account);
    const options = (post.platformOptions ?? {}) as YouTubeOptions;

    await googleRequest(
      `${VIDEOS_URL}?part=snippet,status`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessPlaintextToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: post.platformPostId,
          snippet: {
            title:
              options.title?.trim() ||
              post.caption.split("\n")[0]?.slice(0, 100) ||
              "Untitled",
            description: options.description ?? post.caption,
            ...(toTagList(options.tags).length
              ? { tags: toTagList(options.tags) }
              : {}),
            categoryId: options.categoryId ?? "22",
          },
          status: {
            // Must stay private for publishAt to remain valid.
            privacyStatus: "private",
            publishAt: post.scheduledAt.toISOString(),
            selfDeclaredMadeForKids: options.madeForKids ?? false,
          },
        }),
      },
      "YouTube edit"
    );

    await recordQuotaUsage({
      platform: "YOUTUBE",
      units: YOUTUBE_UPDATE_UNIT_COST,
    });
  },

  async cancel(post: ScheduledPostWithMedia, account: ConnectedAccount) {
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
