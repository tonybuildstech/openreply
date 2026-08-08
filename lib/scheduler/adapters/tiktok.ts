/**
 * TikTok publishing — Content Posting API v2.
 *
 * Dispatch mode: QUEUED. There is no scheduling parameter anywhere in the v2
 * API, and `upload_url` expires after one hour — so init MUST happen at fire
 * time, never in advance.
 *
 * Two post modes, because research (2026-08-06) found Direct Post is probably
 * out of reach here:
 *
 *  - **INBOX** (default) — `/v2/post/publish/inbox/video/init/`. The video is
 *    delivered to the creator's TikTok inbox and they finish posting in the
 *    app. Always available with `video.upload`.
 *  - **DIRECT_POST** — `/v2/post/publish/video/init/`. Posts straight to the
 *    account, but until the app passes TikTok's Content Posting audit every
 *    post is forced to SELF_ONLY (private). TikTok's Content Sharing Guidelines
 *    require API clients target "a wide audience, not… internal groups/private
 *    use", which a self-hosted tool is not — so that audit is unlikely to pass.
 *
 * Inbox is the default precisely because an unaudited Direct Post silently
 * produces a private video the creator never asked for.
 *
 * The composer captures TikTok's mandatory UX (creator_info, an explicitly
 * chosen privacy level, interaction toggles, commercial disclosure) at schedule
 * time; this adapter only replays those stored choices.
 */

import type {
  ConnectedAccount,
  ScheduledPostMedia,
} from "@/app/generated/prisma/client";
import { fetchWithTimeout, toResponseSnippet } from "@/lib/scheduler/http";
import { recordQuotaUsage } from "@/lib/scheduler/quota";
import { resolveAccessToken } from "@/lib/scheduler/tokens";
import {
  PublishError,
  requireSingleMedia,
  type PublishAdapter,
  type PublishStatus,
  type ScheduledPostWithMedia,
} from "@/lib/scheduler/types";
import { getMediaStorage } from "@/lib/storage";

const API_BASE = "https://open.tiktokapis.com/v2";

// TikTok's documented chunk rules: 5 MB minimum, 64 MB maximum, at most 1000
// chunks, and the final chunk may run over chunk_size up to 128 MB.
const MIN_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_CHUNKS = 1000;

export type TikTokPostMode = "INBOX" | "DIRECT_POST";

export interface TikTokAccountMetadata {
  postMode?: TikTokPostMode;
  /** True once TikTok has audited the app for public Direct Post. */
  auditApproved?: boolean;
  creatorUsername?: string;
}

export interface TikTokPostOptions {
  /** Chosen by the user in the composer — TikTok forbids a default. */
  privacyLevel?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  videoCoverTimestampMs?: number;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
}

/**
 * Chunk plan honouring TikTok's rules. `total_chunk_count` must equal
 * floor(size / chunk_size) — the trailing bytes ride along on the final chunk
 * rather than forming one of their own. Getting this wrong yields 400 or 416.
 */
export function planChunks(sizeBytes: number): {
  chunkSize: number;
  totalChunkCount: number;
} {
  // Anything under the 5 MB minimum must go up whole, in a single request.
  if (sizeBytes <= MIN_CHUNK_BYTES) {
    return { chunkSize: sizeBytes, totalChunkCount: 1 };
  }

  let chunkSize = MIN_CHUNK_BYTES;
  // Grow the chunk until the count fits inside TikTok's 1000-chunk ceiling.
  if (Math.floor(sizeBytes / chunkSize) > MAX_CHUNKS) {
    chunkSize = Math.min(
      MAX_CHUNK_BYTES,
      Math.ceil(sizeBytes / MAX_CHUNKS)
    );
  }

  const totalChunkCount = Math.max(1, Math.floor(sizeBytes / chunkSize));
  return { chunkSize, totalChunkCount };
}

async function tiktokRequest(
  path: string,
  accessPlaintextToken: string,
  body: unknown,
  context: string
): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessPlaintextToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body ?? {}),
    timeoutMs: 60_000,
  });

  const payload = (await response.json().catch(() => ({}))) as {
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };

  const code = payload.error?.code;
  if (!response.ok || (code && code !== "ok")) {
    const permanent =
      code === "spam_risk_too_many_posts" ||
      code === "spam_risk_user_banned_from_posting" ||
      code === "spam_risk_text" ||
      code === "spam_risk" ||
      code === "access_token_invalid" ||
      code === "scope_not_authorized";

    throw new PublishError(
      `${context}: ${payload.error?.message ?? code ?? `HTTP ${response.status}`}`,
      !permanent && (response.status >= 500 || response.status === 429),
      {
        needsReauth:
          code === "access_token_invalid" || response.status === 401,
        responseSnippet: toResponseSnippet(payload),
      }
    );
  }

  return payload.data ?? {};
}

/**
 * Upload the file chunk by chunk. TikTok requires strict sequential order — no
 * parallelism — so this is a plain loop, and each slice is streamed from disk
 * to respect the worker's 250 MB cap.
 */
async function uploadChunks(
  media: ScheduledPostMedia,
  uploadUrl: string,
  sizeBytes: number,
  chunkSize: number,
  totalChunkCount: number
): Promise<void> {
  const storage = getMediaStorage();

  for (let index = 0; index < totalChunkCount; index += 1) {
    const start = index * chunkSize;
    // The last chunk absorbs whatever remains, which is why it can exceed
    // chunkSize.
    const end =
      index === totalChunkCount - 1 ? sizeBytes - 1 : start + chunkSize - 1;

    const stream = storage.createReadStream(media.storageKey, {
      start,
      end,
    });

    const response = await fetchWithTimeout(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": media.mimeType,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${sizeBytes}`,
      },
      body: stream as unknown as BodyInit,
      duplex: "half",
      timeoutMs: 10 * 60_000,
    } as RequestInit & { duplex: "half"; timeoutMs: number });

    // 206 = chunk stored, more to come. 201 = that was the last one.
    if (response.status === 206 || response.status === 201) continue;

    if (response.status === 403) {
      // The one-hour upload_url window closed. Nothing to resume — the whole
      // init must be redone, which is what a worker retry does.
      throw new PublishError(
        "TikTok upload link expired before the upload finished",
        true
      );
    }

    const text = await response.text().catch(() => "");
    throw new PublishError(
      `TikTok chunk upload failed (HTTP ${response.status})`,
      response.status >= 500,
      { responseSnippet: toResponseSnippet(text) }
    );
  }
}

export const tiktokAdapter: PublishAdapter = {
  platform: "TIKTOK",
  dispatchMode: "QUEUED",

  async schedule(post: ScheduledPostWithMedia, account: ConnectedAccount) {
    const accessPlaintextToken = await resolveAccessToken(account);
    const metadata = (account.metadata ?? {}) as TikTokAccountMetadata;
    const options = (post.platformOptions ?? {}) as TikTokPostOptions;
    const postMode: TikTokPostMode = metadata.postMode ?? "INBOX";
    // TikTok publishes one video per post. Throws on a carousel rather than
    // silently sending its first item.
    const media = requireSingleMedia(post);

    const storage = getMediaStorage();
    const { size } = await storage.stat(media.storageKey);
    const { chunkSize, totalChunkCount } = planChunks(size);

    const sourceInfo = {
      source: "FILE_UPLOAD",
      video_size: size,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount,
    };

    const isDirect = postMode === "DIRECT_POST";
    const initPath = isDirect
      ? "/post/publish/video/init/"
      : "/post/publish/inbox/video/init/";

    // Direct Post carries the creator's choices; inbox upload takes none of
    // them, because the creator makes those decisions in the TikTok app.
    const initBody = isDirect
      ? {
          post_info: {
            title: post.caption,
            privacy_level: options.privacyLevel ?? "SELF_ONLY",
            disable_comment: options.disableComment ?? false,
            disable_duet: options.disableDuet ?? false,
            disable_stitch: options.disableStitch ?? false,
            ...(options.videoCoverTimestampMs !== undefined
              ? { video_cover_timestamp_ms: options.videoCoverTimestampMs }
              : {}),
            ...(options.brandContentToggle !== undefined
              ? { brand_content_toggle: options.brandContentToggle }
              : {}),
            ...(options.brandOrganicToggle !== undefined
              ? { brand_organic_toggle: options.brandOrganicToggle }
              : {}),
          },
          source_info: sourceInfo,
        }
      : { source_info: sourceInfo };

    const init = await tiktokRequest(
      initPath,
      accessPlaintextToken,
      initBody,
      isDirect ? "TikTok direct post init" : "TikTok inbox upload init"
    );

    const publishId = init.publish_id as string | undefined;
    const uploadUrl = init.upload_url as string | undefined;
    if (!publishId || !uploadUrl) {
      throw new PublishError(
        "TikTok did not return an upload URL",
        true,
        { responseSnippet: toResponseSnippet(init) }
      );
    }

    await uploadChunks(media, uploadUrl, size, chunkSize, totalChunkCount);

    await recordQuotaUsage({
      platform: "TIKTOK",
      connectedAccountId: account.id,
      posts: 1,
    });

    const notice = isDirect
      ? metadata.auditApproved
        ? undefined
        : "Posted privately (SELF_ONLY). TikTok restricts every post from an unaudited app to private — open TikTok to change its visibility."
      : "Sent to your TikTok inbox. Open the TikTok app and tap the notification to finish posting.";

    return { containerId: publishId, notice };
  },

  async checkStatus(
    post: ScheduledPostWithMedia,
    account: ConnectedAccount
  ): Promise<PublishStatus> {
    if (!post.platformContainerId) return "pending";

    const accessPlaintextToken = await resolveAccessToken(account);
    const data = await tiktokRequest(
      "/post/publish/status/fetch/",
      accessPlaintextToken,
      { publish_id: post.platformContainerId },
      "TikTok status check"
    );

    const status = data.status as string | undefined;

    switch (status) {
      case "PUBLISH_COMPLETE":
        return "published";
      case "FAILED":
        return "failed";
      // The video reached the creator's inbox — as far as this integration
      // goes, that IS the delivered state. The creator finishes in the app.
      case "SEND_TO_USER_INBOX":
        return "published";
      default:
        return "pending";
    }
  },
};
