/**
 * Instagram Reels publishing — Instagram API with Instagram Login.
 *
 * Dispatch mode: QUEUED. Instagram has no scheduling parameter of any kind
 * (confirmed against Meta's technical reference — the "schedule posts" claim on
 * Meta's product marketing page applies to other flows). Our worker fires this
 * at the scheduled minute.
 *
 * Flow:
 *   1. POST graph.instagram.com/{v}/{ig-user-id}/media
 *        ?media_type=REELS&video_url=<signed public url>  → container id
 *   2. GET  graph.instagram.com/{v}/{container-id}?fields=status_code
 *        poll until FINISHED — Meta downloads our URL during this window
 *   3. POST graph.instagram.com/{v}/{ig-user-id}/media_publish
 *        creation_id=<container-id>                        → media id
 *
 * **Why `video_url` and not the documented binary upload.** The 2026-08-06
 * research settled on `upload_type=resumable` + a raw-bytes POST to
 * `rupload.facebook.com`, which is what Meta's reference describes. It does not
 * work on `graph.instagram.com`: the parameter is silently ignored and the
 * endpoint falls through to the URL-pull path, answering
 * `The parameter video_url is required` (IGApiException 100). Verified against
 * a live Instagram-Login account on v21.0, v22.0, v23.0, v24.0 and v25.0, with
 * the params in the query string and in the body, against both `/{ig-user-id}`
 * and `/me` — same error every time. The same request with `video_url` returns
 * a container ID. So Meta fetches the file from us instead; see
 * `lib/storage/public-url.ts` for how that URL is secured.
 *
 * Requires `instagram_business_content_publish` — a separate App Review from
 * the messaging scopes this app already holds.
 */

import type { ConnectedAccount } from "@/app/generated/prisma/client";
import { getMetaGraphApiVersion } from "@/lib/env";
import {
  fetchWithTimeout,
  logMetaUsageHeaders,
  toResponseSnippet,
} from "@/lib/scheduler/http";
import { buildSignedMediaUrl } from "@/lib/storage/public-url";
import { resolveAccessToken } from "@/lib/scheduler/tokens";
import {
  PublishError,
  requireSingleMedia,
  type PublishAdapter,
  type ScheduledPostWithMedia,
} from "@/lib/scheduler/types";

const CONTAINER_POLL_INTERVAL_MS = 6_000;
// Meta documents no processing SLA, and this window now also covers Meta
// downloading the file from us. Ten minutes is our own ceiling: long enough for
// a 90-second Reel, short enough that a stuck container frees the worker.
const CONTAINER_POLL_TIMEOUT_MS = 10 * 60_000;

function graphBase(): string {
  return `https://graph.instagram.com/${getMetaGraphApiVersion()}`;
}

/**
 * Reels container options.
 *
 * **Four of these are unverified on this host.** `audioName`, `collaborators`,
 * `locationId` and `userTags` are documented only against `graph.facebook.com`
 * (Facebook Login); Meta's Instagram-Login content-publishing guide never
 * mentions them (research 2026-08-08). Given that `upload_type=resumable` is
 * likewise documented and silently ignored here, they may be doing nothing.
 *
 * They are left in place rather than removed on suspicion — but do not treat
 * them as working until `.dev/probe-ig-params.ts` says so. The composer
 * presents all four as real settings.
 */
interface InstagramOptions {
  shareToFeed?: boolean;
  coverUrl?: string;
  thumbOffset?: number;
  /** NOT a music selector — at most renames the "Original audio" label. */
  audioName?: string;
  collaborators?: string;
  locationId?: string;
  /** Comma-separated usernames from the composer. */
  userTags?: string;
}

/**
 * Meta wants `user_tags` as a JSON array of objects, not a username list.
 * The composer collects the friendlier comma-separated form.
 */
export function toUserTagsParam(usernames: string): string | null {
  const tags = usernames
    .split(",")
    .map((name) => name.trim().replace(/^@/, ""))
    .filter(Boolean)
    .map((username) => ({ username }));

  return tags.length > 0 ? JSON.stringify(tags) : null;
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
 * Fallback cap, used only when Instagram does not tell us its own number.
 *
 * Documented as 50 published items per rolling 24 hours per account, with a
 * carousel counting as ONE regardless of how many children it has (research
 * 2026-08-08). This was 25 until that run — see the note on the response shape
 * below for why the wrong value was reaching this code.
 */
const FALLBACK_DAILY_PUBLISH_CAP = 50;

interface ContentPublishingLimitRow {
  quota_usage?: number;
  config?: { quota_total?: number; quota_duration?: number };
}

/**
 * Instagram's own view of the account's rolling-24h publish budget. We ask
 * rather than hardcode, because Meta's documented cap has moved and their docs
 * have disagreed with each other about it.
 *
 * **The limit is nested under `config`, not top-level.** The response is
 * `{ data: [{ quota_usage, config: { quota_total, quota_duration } }] }` —
 * there is no `quota_limit` field, which is what this code asked for until
 * 2026-08-08. The effect was quiet and wrong in the expensive direction: the
 * read always fell through to its default of 25, so between 25 and 50 posts in
 * a day this threw `retryable`, and the worker requeued posts Instagram would
 * have accepted.
 */
async function assertPublishingHeadroom(
  igUserId: string,
  accessPlaintextToken: string
): Promise<void> {
  const url =
    `${graphBase()}/${igUserId}/content_publishing_limit` +
    `?fields=quota_usage,config&access_token=${encodeURIComponent(accessPlaintextToken)}`;

  let body: Record<string, unknown>;
  try {
    body = await metaRequest(url, { method: "GET" }, "Instagram quota check");
  } catch {
    // A failing pre-flight check must not block publishing — the publish call
    // enforces the real limit anyway and will tell us plainly if we exceed it.
    return;
  }

  const row = (body.data as ContentPublishingLimitRow[] | undefined)?.[0];
  if (!row) return;

  const usage = row.quota_usage ?? 0;
  const limit = row.config?.quota_total ?? FALLBACK_DAILY_PUBLISH_CAP;

  if (usage >= limit) {
    // Requeue-worthy: the window rolls forward, so this genuinely succeeds later.
    throw new PublishError(
      `Instagram publishing limit reached (${usage}/${limit} in the last 24 hours)`,
      true
    );
  }
}

async function createContainer(
  post: ScheduledPostWithMedia,
  igUserId: string,
  accessPlaintextToken: string
): Promise<string> {
  const options = (post.platformOptions ?? {}) as InstagramOptions;
  // Reels are one video. IMAGE and CAROUSEL posts get their own paths in a
  // follow-up step; until then this adapter still only publishes REEL, and
  // refuses anything multi-item rather than publishing part of it.
  const media = requireSingleMedia(post);

  // Thrown before we touch Meta when the deployment has no public HTTPS base
  // URL — a `localhost` video_url would only surface ten minutes later as an
  // unexplained container ERROR.
  let videoUrl: string;
  try {
    videoUrl = buildSignedMediaUrl(media.storageKey);
  } catch (error) {
    throw new PublishError(
      error instanceof Error ? error.message : "Cannot build a public video URL",
      false
    );
  }

  const params = new URLSearchParams({
    media_type: "REELS",
    video_url: videoUrl,
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
  if (options.locationId) params.set("location_id", options.locationId);
  if (options.userTags) {
    const userTags = toUserTagsParam(options.userTags);
    if (userTags) params.set("user_tags", userTags);
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
        "Instagram could not process this video. Either it does not meet Reels requirements (MP4, 3–90s, vertical), or Instagram could not download it from this server.",
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

  async schedule(post: ScheduledPostWithMedia, account: ConnectedAccount) {
    const accessPlaintextToken = await resolveAccessToken(account);
    const igUserId = account.platformAccountId;

    await assertPublishingHeadroom(igUserId, accessPlaintextToken);

    const containerId = await createContainer(
      post,
      igUserId,
      accessPlaintextToken
    );
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
