/**
 * Instagram Reels publishing — Instagram API with Instagram Login.
 *
 * Dispatch mode: QUEUED. Instagram has no scheduling parameter of any kind
 * (confirmed against Meta's technical reference — the "schedule posts" claim on
 * Meta's product marketing page applies to other flows). Our worker fires this
 * at the scheduled minute.
 *
 * Three post shapes, all ending in the same publish call. Every parameter below
 * is confirmed against Meta's **Instagram Login** content-publishing guide
 * (research 2026-08-08) — not the IG User Media reference, which documents the
 * Facebook Login flow and differs in ways that matter.
 *
 *   REEL      POST /{ig-user-id}/media  media_type=REELS  video_url=<signed>
 *
 *   IMAGE     POST /{ig-user-id}/media  image_url=<signed>
 *             NO media_type. `IMAGE` is not a documented value — the feed-image
 *             example omits the parameter entirely, and the documented set is
 *             REELS / STORIES / CAROUSEL / VIDEO.
 *
 *   CAROUSEL  per item, in position order:
 *               POST /{ig-user-id}/media  is_carousel_item=true
 *                 image_url=<signed>                     (IMAGE child)
 *                 media_type=VIDEO & video_url=<signed>  (VIDEO child)
 *               children carry NO caption — it belongs on the parent
 *             then:
 *               POST /{ig-user-id}/media  media_type=CAROUSEL
 *                 children=id1,id2,id3   ← comma-separated STRING, not JSON
 *                 caption=…
 *
 * Then for all three:
 *   GET  /{container-id}?fields=status_code  → poll until FINISHED
 *   POST /{ig-user-id}/media_publish  creation_id=<container-id>  → media id
 *
 * **`children` is a string.** Meta's IG User Media reference calls it
 * `<ARRAY_OF_CAROUSEL_CONTAINER_IDS>`, which reads like JSON and is not; the
 * Instagram Login guide's own example is a plain comma-joined string.
 *
 * **Video children take `media_type=VIDEO`, never `REELS`.** Meta is explicit
 * that "reels are not supported" as carousel items.
 *
 * **Carousels count as ONE post** against the account's 50-per-24h publishing
 * limit, however many children they have.
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

import type {
  ConnectedAccount,
  ScheduledPostMedia,
} from "@/app/generated/prisma/client";
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

// Meta documents no processing SLA, and this window also covers Meta
// downloading the file from us. Ten minutes is our own ceiling: long enough for
// a 90-second Reel, short enough that a stuck container frees the worker.
const SINGLE_CONTAINER_BUDGET_MS = 10 * 60_000;

/**
 * Budget for a WHOLE carousel — every child plus the parent — not per container.
 *
 * Ten videos at ten minutes each would be 100 minutes, against signed media URLs
 * that expire in two hours (`lib/storage/public-url.ts`) and child containers
 * that expire 24h from their own creation. A shared deadline keeps the slowest
 * case bounded instead of letting it creep up on both expiries at once.
 */
const CAROUSEL_TOTAL_BUDGET_MS = 20 * 60_000;

/**
 * What a post's files are, for choosing the error copy when one is rejected.
 * MIXED covers a carousel of both, where we cannot say which item failed.
 */
type MediaKind = "IMAGE" | "VIDEO" | "MIXED";

function mediaKindOf(post: ScheduledPostWithMedia): MediaKind {
  const kinds = new Set(post.media.map((item) => item.kind));
  return kinds.size === 1 ? (post.media[0].kind as MediaKind) : "MIXED";
}

/** Meta's documented ceiling: "up to 10 images, videos, or a mix of the two". */
const CAROUSEL_MAX_CHILDREN = 10;
/**
 * Our floor, not Meta's — the docs state no minimum (see Q14). Two is what the
 * Instagram app itself requires, and a one-item "carousel" should be an IMAGE
 * or REEL post instead.
 */
const CAROUSEL_MIN_CHILDREN = 2;

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

/**
 * A publicly fetchable URL for one stored file.
 *
 * Called for every item BEFORE any container is created, so a deployment with
 * no public HTTPS base URL fails immediately instead of leaving half a carousel
 * of containers behind and surfacing as an unexplained ERROR ten minutes later.
 */
function signedUrlFor(storageKey: string): string {
  try {
    return buildSignedMediaUrl(storageKey);
  } catch (error) {
    throw new PublishError(
      error instanceof Error ? error.message : "Cannot build a public media URL",
      false
    );
  }
}

/** POST /{ig-user-id}/media, returning the new container's ID. */
async function createMediaContainer(
  igUserId: string,
  params: URLSearchParams,
  accessPlaintextToken: string,
  context: string
): Promise<string> {
  params.set("access_token", accessPlaintextToken);

  const body = await metaRequest(
    `${graphBase()}/${igUserId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    context
  );

  const containerId = body.id as string | undefined;
  if (!containerId) {
    throw new PublishError(`${context}: no container ID returned`, true, {
      responseSnippet: toResponseSnippet(body),
    });
  }

  return containerId;
}

/** Reels: one video, plus the full option set the composer collects. */
function reelParams(
  post: ScheduledPostWithMedia,
  media: ScheduledPostMedia
): URLSearchParams {
  const options = (post.platformOptions ?? {}) as InstagramOptions;

  const params = new URLSearchParams({
    media_type: "REELS",
    video_url: signedUrlFor(media.storageKey),
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

  return params;
}

/**
 * Single feed image.
 *
 * Caption only, deliberately. `location_id`, `user_tags` and `collaborators`
 * are documented for images ONLY against `graph.facebook.com`, and image
 * `user_tags` are documented as `{username, x, y}` while our composer collects
 * bare usernames (Q16/Q17). Sending unverified parameters risks a `(#100)` on a
 * post that would otherwise publish; add them once `.dev/probe-ig-params.ts`
 * confirms them.
 */
function imageParams(
  post: ScheduledPostWithMedia,
  media: ScheduledPostMedia
): URLSearchParams {
  // No media_type: the documented feed-image example omits it, and `IMAGE` is
  // not among the accepted values (REELS / STORIES / CAROUSEL / VIDEO).
  const params = new URLSearchParams({
    image_url: signedUrlFor(media.storageKey),
  });
  if (post.caption) params.set("caption", post.caption);
  return params;
}

/** One carousel child. Never carries a caption — that lives on the parent. */
function carouselChildParams(media: ScheduledPostMedia): URLSearchParams {
  const params = new URLSearchParams({ is_carousel_item: "true" });

  if (media.kind === "IMAGE") {
    params.set("image_url", signedUrlFor(media.storageKey));
  } else {
    // VIDEO, never REELS — Meta documents that reels are not valid carousel
    // items, and passing REELS earns "The media type entered is not one of the
    // expected media types."
    params.set("media_type", "VIDEO");
    params.set("video_url", signedUrlFor(media.storageKey));
  }

  return params;
}

/**
 * Why a container failed, in words the user can act on.
 *
 * Instagram reports asset problems as a terminal container ERROR with the real
 * reason buried in `status`, so the dashboard would otherwise show "could not
 * process this" for a file that is simply the wrong shape. All permanent:
 * retrying the same bytes reproduces them exactly.
 */
function containerErrorMessage(kind: MediaKind): string {
  if (kind === "IMAGE") {
    return "Instagram rejected this image. It must be within a 4:5 to 1.91:1 aspect ratio and under 8 MB, and this server must be reachable for Instagram to download it.";
  }
  if (kind === "VIDEO") {
    return "Instagram could not process this video. Either it does not meet Instagram's requirements (MP4 or MOV), or Instagram could not download it from this server.";
  }
  return "Instagram could not process one of these files. Images must be within a 4:5 to 1.91:1 aspect ratio and under 8 MB; videos must be MP4 or MOV. This server must also be reachable for Instagram to download them.";
}

async function waitForContainer(
  containerId: string,
  accessPlaintextToken: string,
  deadline: number,
  label: string,
  kind: MediaKind = "MIXED"
): Promise<void> {
  while (Date.now() < deadline) {
    const body = await metaRequest(
      `${graphBase()}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessPlaintextToken)}`,
      { method: "GET" },
      `Instagram container status (${label})`
    );

    const status = body.status_code as string | undefined;

    if (status === "FINISHED") return;

    if (status === "ERROR") {
      // Documented as terminal. The container cannot be reused; a retry must
      // start from a fresh one, which is what the worker's retry does.
      throw new PublishError(containerErrorMessage(kind), false, {
        responseSnippet: toResponseSnippet(body),
      });
    }

    if (status === "EXPIRED") {
      // Containers must be published within 24h of creation. Retryable, because
      // a fresh attempt builds a new container from scratch.
      throw new PublishError(
        `Instagram expired this container before it could be published (${label})`,
        true,
        { responseSnippet: toResponseSnippet(body) }
      );
    }

    if (status === "PUBLISHED") {
      // Already live. Returning rather than throwing avoids publishing a second
      // copy on a retry that raced an earlier success.
      return;
    }

    // IN_PROGRESS is the only remaining documented value. Anything else is
    // terminal-unknown rather than assumed recoverable: silently retrying a
    // stale container is exactly the failure mode to avoid.
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
    `Instagram is still processing this post (${label}) — gave up waiting`,
    true
  );
}

/**
 * Build and prepare a carousel, returning the parent container ID.
 *
 * **Order is the contract.** `post.media` arrives sorted by `position` (see the
 * include in `lib/scheduler/dispatch.ts`) and Instagram renders children in the
 * order they appear in `children`, so this must never reorder them or fan out
 * into an unordered collection.
 *
 * **No cleanup on partial failure.** If child 7 of 10 fails, six containers are
 * left dangling. They expire on their own within 24h and cost nothing, and Meta
 * documents no delete. What matters is that a retry builds FRESH children —
 * these IDs are locals and are never persisted, so a retry cannot reuse them.
 * Do not "optimise" that into a cache.
 */
async function createCarouselContainer(
  post: ScheduledPostWithMedia,
  igUserId: string,
  accessPlaintextToken: string,
  deadline: number
): Promise<string> {
  const items = post.media;

  // The API and composer both check this first; this is the backstop, and it
  // runs before any container is created so a bad post costs no API calls.
  if (
    items.length < CAROUSEL_MIN_CHILDREN ||
    items.length > CAROUSEL_MAX_CHILDREN
  ) {
    throw new PublishError(
      `An Instagram carousel needs between ${CAROUSEL_MIN_CHILDREN} and ${CAROUSEL_MAX_CHILDREN} items — this post has ${items.length}`,
      false
    );
  }

  const childIds: string[] = [];
  for (const [index, media] of items.entries()) {
    const childId = await createMediaContainer(
      igUserId,
      carouselChildParams(media),
      accessPlaintextToken,
      `Instagram carousel item ${index + 1} of ${items.length}`
    );

    // Images are fetched during creation and normally come back FINISHED at
    // once; videos genuinely process. Polling both keeps one rule, and an
    // already-finished container costs a single extra GET.
    await waitForContainer(
      childId,
      accessPlaintextToken,
      deadline,
      `item ${index + 1} of ${items.length}`,
      media.kind
    );

    childIds.push(childId);
  }

  const params = new URLSearchParams({
    media_type: "CAROUSEL",
    // A comma-joined STRING. Meta's reference calls this
    // <ARRAY_OF_CAROUSEL_CONTAINER_IDS>, which is misleading — it is not JSON.
    children: childIds.join(","),
  });
  if (post.caption) params.set("caption", post.caption);

  return createMediaContainer(
    igUserId,
    params,
    accessPlaintextToken,
    "Instagram carousel container"
  );
}

/**
 * Create the container for whichever post shape this is, and wait for it to be
 * ready to publish.
 */
async function prepareContainer(
  post: ScheduledPostWithMedia,
  igUserId: string,
  accessPlaintextToken: string
): Promise<string> {
  if (post.mediaType === "CAROUSEL") {
    // One budget for every child AND the parent, not one per container.
    const deadline = Date.now() + CAROUSEL_TOTAL_BUDGET_MS;
    const containerId = await createCarouselContainer(
      post,
      igUserId,
      accessPlaintextToken,
      deadline
    );
    await waitForContainer(
      containerId,
      accessPlaintextToken,
      deadline,
      "carousel",
      mediaKindOf(post)
    );
    return containerId;
  }

  // REEL and IMAGE are both exactly one file.
  const media = requireSingleMedia(post);
  const deadline = Date.now() + SINGLE_CONTAINER_BUDGET_MS;

  if (post.mediaType === "IMAGE") {
    const containerId = await createMediaContainer(
      igUserId,
      imageParams(post, media),
      accessPlaintextToken,
      "Instagram image container"
    );
    await waitForContainer(
      containerId,
      accessPlaintextToken,
      deadline,
      "image",
      "IMAGE"
    );
    return containerId;
  }

  if (post.mediaType === "REEL") {
    const containerId = await createMediaContainer(
      igUserId,
      reelParams(post, media),
      accessPlaintextToken,
      "Instagram Reel container"
    );
    await waitForContainer(
      containerId,
      accessPlaintextToken,
      deadline,
      "reel",
      "VIDEO"
    );
    return containerId;
  }

  // Reachable only if MEDIA_TYPE_BY_PLATFORM gains an Instagram post type that
  // this adapter has no path for. Failing loudly beats publishing the wrong
  // shape — which is exactly what happened when IMAGE and CAROUSEL were added
  // to that map before these branches existed.
  throw new PublishError(
    `Instagram cannot publish a ${post.mediaType} post`,
    false
  );
}

export const instagramAdapter: PublishAdapter = {
  platform: "INSTAGRAM",
  dispatchMode: "QUEUED",

  async schedule(post: ScheduledPostWithMedia, account: ConnectedAccount) {
    const accessPlaintextToken = await resolveAccessToken(account);
    const igUserId = account.platformAccountId;

    // A carousel counts as ONE published item however many children it has, so
    // the headroom check is the same for all three shapes.
    await assertPublishingHeadroom(igUserId, accessPlaintextToken);

    const containerId = await prepareContainer(
      post,
      igUserId,
      accessPlaintextToken
    );

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
