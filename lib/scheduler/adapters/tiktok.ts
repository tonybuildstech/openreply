/**
 * TikTok publishing — Content Posting API v2.
 *
 * Dispatch mode: QUEUED. There is no scheduling parameter anywhere in the v2
 * API, and `upload_url` expires after one hour — so init MUST happen at fire
 * time, never in advance.
 *
 * **Two endpoints, not one.** Video and photos share nothing but the status
 * poll (research 2026-08-08):
 *
 *  - **Video** — `/post/publish/video/init/` or `/post/publish/inbox/video/init/`,
 *    then the file is streamed to `upload_url` in chunks. `FILE_UPLOAD`.
 *  - **Photo carousel** — `/post/publish/content/init/` with `media_type=PHOTO`,
 *    up to 35 stills, and **`PULL_FROM_URL` only**: there is no photo
 *    `FILE_UPLOAD`, so TikTok fetches every image FROM this server. That makes
 *    the signed-URL layer in `lib/storage/public-url.ts` load-bearing, and it
 *    means the app's domain must be verified in the TikTok developer console
 *    or every init returns `url_ownership_unverified`.
 *
 * `/content/init/` is NOT a unified endpoint — TikTok documents no
 * `media_type=VIDEO` for it and has announced no sunset for `/video/init/`, so
 * the video path below stays exactly where it is.
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
 * For photos the same split reads as INBOX → `MEDIA_UPLOAD`, and the default is
 * even easier to defend: an unaudited Direct Post is private AND carries a
 * track TikTok chose, whereas finishing in the app gives the creator a public
 * post and any sound they like. There is no API for picking a sound — the only
 * music field in the whole Content Posting API is `auto_add_music`, a boolean
 * that asks TikTok to pick one, and it works on Direct Post alone.
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
  TIKTOK_PHOTO_MAX_ITEMS,
  type PublishAdapter,
  type PublishResult,
  type PublishStatus,
  type ScheduledPostWithMedia,
} from "@/lib/scheduler/types";
import { getMediaStorage } from "@/lib/storage";
import { buildSignedMediaUrl } from "@/lib/storage/public-url";

const API_BASE = "https://open.tiktokapis.com/v2";

// TikTok's documented chunk rules: 5 MB minimum, 64 MB maximum, at most 1000
// chunks, and the final chunk may run over chunk_size up to 128 MB.
const MIN_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_CHUNKS = 1000;

/**
 * How long the signed image URLs stay alive for a photo carousel.
 *
 * Longer than the 2 h default `buildSignedMediaUrl` gives Instagram, because
 * TikTok's guarantee is weaker: the docs promise only that the URL must remain
 * reachable "for the entire duration of the download process, which times out
 * one hour after the download task is initiated", say nothing about whether it
 * re-fetches later, and say nothing about how many of the 35 it pulls at once.
 * Four hours is one download window plus room for a worker retry.
 *
 * The URLs are deliberately NOT single-use for the same reason — nothing in the
 * docs promises TikTok fetches each image exactly once.
 */
const PHOTO_URL_TTL_MS = 4 * 60 * 60 * 1000;

/** TikTok's documented ceiling on a photo post's description. */
const MAX_DESCRIPTION_CHARS = 4000;
/** ...and on its title. Both are counted in UTF-16 runes. */
const MAX_TITLE_CHARS = 90;
/**
 * A video's caption goes in `post_info.title`, and its ceiling is far higher
 * than the photo title's 90 — 2200 UTF-16 runes (research 2026-08-14). Video
 * has NO `description` field; sending one is undocumented and rejected as
 * `invalid_param`, so the caption must never be split across two keys here.
 */
const MAX_VIDEO_TITLE_CHARS = 2200;

export type TikTokPostMode = "INBOX" | "DIRECT_POST";

export type TikTokPrivacyLevel =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY";

/**
 * What `/v2/post/publish/creator_info/query/` tells us about one creator.
 *
 * TikTok requires this to be queried when rendering the post page, and the
 * values are per-creator and mutable — a private account, for instance, is
 * never offered `PUBLIC_TO_EVERYONE`, and gets `FOLLOWER_OF_CREATOR` instead.
 * Hardcoding the privacy list (which is what we did before) therefore offers
 * levels the account cannot use, and the post fails at publish with
 * `privacy_level_option_mismatch` — after the video has finished uploading.
 */
export interface TikTokCreatorInfo {
  creatorUsername?: string;
  creatorNickname?: string;
  creatorAvatarUrl?: string;
  privacyLevelOptions: TikTokPrivacyLevel[];
  commentDisabled: boolean;
  /** Video-only signals; TikTok says to ignore them for photo-only posts. */
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec?: number;
}

/**
 * Current posting settings for the creator behind `accessPlaintextToken`.
 *
 * Deliberately NOT cached: the whole point is that these values are live, and a
 * creator can flip their account to private between scheduling a post and the
 * worker publishing it.
 */
export async function queryCreatorInfo(
  accessPlaintextToken: string
): Promise<TikTokCreatorInfo> {
  const data = await tiktokRequest(
    "/post/publish/creator_info/query/",
    accessPlaintextToken,
    {},
    "TikTok creator info"
  );

  const options = Array.isArray(data.privacy_level_options)
    ? (data.privacy_level_options as TikTokPrivacyLevel[])
    : [];

  return {
    creatorUsername: data.creator_username as string | undefined,
    creatorNickname: data.creator_nickname as string | undefined,
    creatorAvatarUrl: data.creator_avatar_url as string | undefined,
    privacyLevelOptions: options,
    commentDisabled: data.comment_disabled === true,
    duetDisabled: data.duet_disabled === true,
    stitchDisabled: data.stitch_disabled === true,
    maxVideoPostDurationSec:
      typeof data.max_video_post_duration_sec === "number"
        ? data.max_video_post_duration_sec
        : undefined,
  };
}

/**
 * Confirms the privacy level chosen at schedule time is still one the creator
 * can use, and fails loudly when it is not.
 *
 * A scheduler can sit on a choice for days, and TikTok's guidance covers only
 * synchronous "Export to TikTok" flows — it never says what to do when the
 * account changed in between. We verify rather than re-map: silently downgrading
 * someone's privacy choice is the one behaviour TikTok's UX guidelines
 * explicitly warn against, so a clear failure the user can act on beats a post
 * that quietly went out more visibly (or less) than they asked for.
 *
 * Non-permanent on purpose — the creator can flip the setting back and retry.
 */
function assertPrivacyStillAllowed(
  chosen: TikTokPrivacyLevel,
  info: TikTokCreatorInfo
): void {
  // An empty list means TikTok told us nothing useful; treating that as "reject
  // everything" would fail posts over a transient API quirk.
  if (info.privacyLevelOptions.length === 0) return;
  if (info.privacyLevelOptions.includes(chosen)) return;

  throw new PublishError(
    `TikTok no longer allows "${chosen}" for this account — it now offers ${info.privacyLevelOptions.join(", ")}. ` +
      "This usually means the account switched between public and private. Edit the post's privacy setting and reschedule.",
    false
  );
}

export interface TikTokAccountMetadata {
  postMode?: TikTokPostMode;
  /** True once TikTok has audited the app for public Direct Post. */
  auditApproved?: boolean;
  creatorUsername?: string;
}

export interface TikTokPostOptions {
  /** Chosen by the user in the composer — TikTok forbids a default. */
  privacyLevel?: TikTokPrivacyLevel;
  disableComment?: boolean;
  /** Video only — TikTok's photo endpoint documents neither. */
  disableDuet?: boolean;
  disableStitch?: boolean;
  videoCoverTimestampMs?: number;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
  /**
   * Marks the video as AI-generated, which makes TikTok attach its "Creator
   * labeled as AI-generated" tag. **Video Direct Post only** — the photo
   * endpoint does not document it (research 2026-08-14).
   *
   * Omitting it defaults to false, so the risk of not sending it is a policy
   * one rather than a schema one: TikTok expects AI content to carry the label
   * and may restrict or remove it when unlabeled.
   */
  isAigc?: boolean;

  // --- Photo carousels only ---

  /**
   * Photo posts carry a title AND a description; video carries only a title.
   * The post's caption becomes the description (that is where TikTok's own
   * example puts hashtags and mentions), so this is the separate short headline
   * and is omitted entirely when the composer collected none.
   */
  title?: string;
  /**
   * Which image is the cover. Zero-based, and not necessarily the first — hence
   * a stored choice rather than a hardcoded 0.
   */
  photoCoverIndex?: number;
  /**
   * Ask TikTok to attach a recommended track. **This is not a track picker** —
   * no such API exists — and it works on Direct Post only. The creator can
   * change whatever TikTok chose, in the app, after the fact.
   */
  autoAddMusic?: boolean;
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
  // A one-chunk upload sends the whole file in a single request, so chunk_size
  // IS the file size. TikTok rejects a chunk_size describing less than what it
  // is about to receive — "The chunk size is invalid" on init.
  //
  // The bound is 10 MB, not the 5 MB minimum, because floor(size / 5 MB) is
  // still 1 all the way up to 10 MB: an 8.55 MB video declared 5 MB chunks and
  // one chunk, which is a contradiction. Below 5 MB this is also TikTok's own
  // documented exception (chunk_size = video_size), so one branch serves both.
  // The resulting chunk_size stays inside the 5–64 MB band wherever the
  // documented minimum applies.
  if (sizeBytes < 2 * MIN_CHUNK_BYTES) {
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
      code === "scope_not_authorized" ||
      // Photo carousels only: TikTok will not fetch media from a domain that
      // has not been verified in the developer console. Retrying cannot fix a
      // configuration problem, and the message has to say where to go.
      code === "url_ownership_unverified" ||
      // Unaudited clients may only post for a handful of creators a day.
      code === "reached_active_user_cap" ||
      code === "unaudited_client_can_only_post_to_private_accounts";

    const message =
      code === "url_ownership_unverified"
        ? `${context}: TikTok will not fetch media from this server. Verify this app's domain or the URL prefix /api/media/public/ in the TikTok developer console — see docs/setup.md.`
        : `${context}: ${payload.error?.message ?? code ?? `HTTP ${response.status}`}`;

    throw new PublishError(
      message,
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

/**
 * Publish a photo carousel — `/post/publish/content/init/`, `PULL_FROM_URL`.
 *
 * Nothing is uploaded here. TikTok is handed signed HTTPS links and fetches the
 * images itself, so this holds no file bytes at all — which suits the worker's
 * 250 MB cap far better than the chunked video path does.
 */
async function schedulePhotoCarousel(
  post: ScheduledPostWithMedia,
  account: ConnectedAccount,
  accessPlaintextToken: string,
  metadata: TikTokAccountMetadata,
  options: TikTokPostOptions
): Promise<PublishResult> {
  if (post.media.length === 0) {
    throw new PublishError("This post has no media attached", false);
  }
  if (post.media.length > TIKTOK_PHOTO_MAX_ITEMS) {
    throw new PublishError(
      `TikTok takes at most ${TIKTOK_PHOTO_MAX_ITEMS} photos in one post — this one has ${post.media.length}`,
      false
    );
  }
  if (post.caption.length > MAX_DESCRIPTION_CHARS) {
    throw new PublishError(
      `TikTok caps a photo post's description at ${MAX_DESCRIPTION_CHARS} characters — this caption is ${post.caption.length}`,
      false
    );
  }

  const isDirect = (metadata.postMode ?? "INBOX") === "DIRECT_POST";

  // Only Direct Post carries a privacy level, so only Direct Post can fall out
  // of step with the creator's current settings.
  if (isDirect) {
    assertPrivacyStillAllowed(
      options.privacyLevel ?? "SELF_ONLY",
      await queryCreatorInfo(accessPlaintextToken)
    );
  }

  // Clamped rather than trusted: a stored index left over from an edit that
  // removed items would otherwise be rejected by TikTok as out of range.
  const coverIndex = Math.min(
    Math.max(options.photoCoverIndex ?? 0, 0),
    post.media.length - 1
  );

  // Media rows arrive ordered by `position`, and that order IS the order the
  // viewer swipes through.
  const photoImages = post.media.map((item) =>
    buildSignedMediaUrl(item.storageKey, PHOTO_URL_TTL_MS)
  );

  const title = options.title?.slice(0, MAX_TITLE_CHARS);

  const initBody = {
    media_type: "PHOTO",
    post_mode: isDirect ? "DIRECT_POST" : "MEDIA_UPLOAD",
    post_info: {
      ...(title ? { title } : {}),
      description: post.caption,
      // Everything below is documented as Direct Post only. On the inbox path
      // the creator makes these choices in the TikTok app, and sending them
      // would claim a decision the user never made.
      //
      // Note what is NOT here: `disable_duet`, `disable_stitch` and
      // `video_cover_timestamp_ms` are video-only fields, and TikTok does not
      // document whether an extraneous field is ignored or rejected. They are
      // omitted rather than sent as `false`.
      ...(isDirect
        ? {
            privacy_level: options.privacyLevel ?? "SELF_ONLY",
            disable_comment: options.disableComment ?? false,
            auto_add_music: options.autoAddMusic ?? false,
            // The photo reference marks both required while its own example
            // omits them. Explicit booleans satisfy either reading.
            brand_content_toggle: options.brandContentToggle ?? false,
            brand_organic_toggle: options.brandOrganicToggle ?? false,
          }
        : {}),
    },
    source_info: {
      // The only mode photos support — there is no photo FILE_UPLOAD.
      source: "PULL_FROM_URL",
      photo_images: photoImages,
      photo_cover_index: coverIndex,
    },
  };

  const init = await tiktokRequest(
    "/post/publish/content/init/",
    accessPlaintextToken,
    initBody,
    isDirect ? "TikTok photo post init" : "TikTok photo upload init"
  );

  // No `upload_url` on this path — there is nothing to upload to.
  const publishId = init.publish_id as string | undefined;
  if (!publishId) {
    throw new PublishError("TikTok did not return a publish ID", true, {
      responseSnippet: toResponseSnippet(init),
    });
  }

  await recordQuotaUsage({
    platform: "TIKTOK",
    connectedAccountId: account.id,
    // One publish action however many photos it carries, which is also how
    // TikTok counts it against the per-creator daily cap.
    posts: 1,
  });

  const notice = isDirect
    ? metadata.auditApproved
      ? undefined
      : "Posted privately (SELF_ONLY). TikTok restricts every post from an unaudited app to private — open TikTok to change its visibility."
    : "Sent to your TikTok inbox. Open the TikTok app to choose a sound and finish posting.";

  return { containerId: publishId, notice };
}

export const tiktokAdapter: PublishAdapter = {
  platform: "TIKTOK",
  dispatchMode: "QUEUED",

  async schedule(post: ScheduledPostWithMedia, account: ConnectedAccount) {
    const accessPlaintextToken = await resolveAccessToken(account);
    const metadata = (account.metadata ?? {}) as TikTokAccountMetadata;
    const options = (post.platformOptions ?? {}) as TikTokPostOptions;

    // Photos are a different endpoint, a different transfer mode and a
    // different field set. Branch before anything video-shaped happens.
    if (post.mediaType === "TIKTOK_PHOTO") {
      return schedulePhotoCarousel(
        post,
        account,
        accessPlaintextToken,
        metadata,
        options
      );
    }

    const postMode: TikTokPostMode = metadata.postMode ?? "INBOX";

    // Checked before a single byte is uploaded. The caption only reaches TikTok
    // on the Direct Post path — inbox init carries no `post_info` — so an
    // over-long caption is only a failure there, and failing here saves a
    // chunked upload of the whole file first.
    if (postMode === "DIRECT_POST" && post.caption.length > MAX_VIDEO_TITLE_CHARS) {
      throw new PublishError(
        `TikTok caps a video caption at ${MAX_VIDEO_TITLE_CHARS} characters — this one is ${post.caption.length}`,
        false
      );
    }
    // A TikTok video post publishes one file. Throws on a carousel rather than
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

    // Before the chunked upload, not after: a rejected init once the whole file
    // has transferred wastes the creator's bandwidth and ours.
    if (isDirect) {
      assertPrivacyStillAllowed(
        options.privacyLevel ?? "SELF_ONLY",
        await queryCreatorInfo(accessPlaintextToken)
      );
    }

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
            // Sent unconditionally, unlike the cover timestamp above. TikTok's
            // Direct Post video reference marks both commercial-disclosure
            // fields REQUIRED (research 2026-08-14) — omitting them when the
            // composer collected no explicit choice risked a rejected init
            // *after* the whole video had already been chunk-uploaded. `false`
            // is also the honest value: it is the answer the disclosure toggle
            // shows by default, so sending it claims nothing the user did not.
            brand_content_toggle: options.brandContentToggle ?? false,
            brand_organic_toggle: options.brandOrganicToggle ?? false,
            is_aigc: options.isAigc ?? false,
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
      // The media reached the creator's inbox — as far as this integration
      // goes, that IS the delivered state. The creator finishes in the app.
      case "SEND_TO_USER_INBOX":
        return "published";
      // Photo carousels only: TikTok is still fetching the images from us. The
      // signed URLs must outlive this, which is why they get four hours.
      case "PROCESSING_DOWNLOAD":
        return "pending";
      default:
        return "pending";
    }
  },
};
