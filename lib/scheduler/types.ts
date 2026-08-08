/**
 * The publish adapter contract.
 *
 * The spine of this feature is a split, confirmed by research (2026-08-06/09):
 *
 *   NATIVE  — the platform holds the timer. `schedule()` runs once, at the
 *             moment the user schedules, and the platform publishes later.
 *             Facebook Pages (feed video AND Reels) and YouTube (`publishAt`).
 *
 *   QUEUED  — the platform has no scheduling parameter at all. `schedule()`
 *             runs in the worker at the scheduled minute and publishes
 *             immediately. Instagram and TikTok.
 *
 * `dispatchMode` is what the fire-time poll and the composer both key off, so
 * it lives on the adapter rather than in a lookup table someone can forget to
 * update.
 */

import type {
  ConnectedAccount,
  ScheduledPost,
  ScheduledPostMedia,
  SocialPlatform,
} from "@/app/generated/prisma/client";

export type DispatchMode = "NATIVE" | "QUEUED";

/**
 * A post with its files attached, in carousel order.
 *
 * Adapters are always handed this, never a bare `ScheduledPost` — the media
 * relation is the only place a storage key lives. `dispatchScheduledPost` is
 * responsible for loading it ordered by `position`.
 */
export type ScheduledPostWithMedia = ScheduledPost & {
  media: ScheduledPostMedia[];
};

/**
 * The single file a one-file platform publishes.
 *
 * Only Instagram accepts a carousel. YouTube, TikTok and Facebook take exactly
 * one video, so this throws rather than quietly publishing item 0 — a user who
 * scheduled a 5-image carousel to TikTok must be told it cannot work, not
 * discover later that one arbitrary frame of it went out. The API and composer
 * both refuse this combination first; this is the backstop for the case where
 * they don't.
 */
export function requireSingleMedia(
  post: ScheduledPostWithMedia
): ScheduledPostMedia {
  const [first] = post.media;

  if (!first) {
    throw new PublishError("This post has no media attached", false);
  }

  if (post.media.length > 1) {
    throw new PublishError(
      `This platform publishes a single file, but this post has ${post.media.length}. Schedule the carousel to Instagram on its own.`,
      false
    );
  }

  return first;
}

export interface PublishResult {
  /** The platform's ID for the published or scheduled post, when it gives one. */
  platformPostId?: string;
  /** IG container ID / TikTok publish_id / YouTube video ID / FB video ID. */
  containerId?: string;
  /**
   * True when the platform accepted a future timestamp and now owns the timer.
   * The post moves to SCHEDULED_REMOTE rather than PUBLISHED.
   */
  scheduledRemotely?: boolean;
  /** Shown to the user verbatim, e.g. TikTok's inbox and privacy caveats. */
  notice?: string;
}

export type PublishStatus = "pending" | "published" | "failed";

export interface PublishAdapter {
  readonly platform: SocialPlatform;
  readonly dispatchMode: DispatchMode;

  schedule(
    post: ScheduledPostWithMedia,
    account: ConnectedAccount
  ): Promise<PublishResult>;

  /** Confirm a post that the platform processes asynchronously. */
  checkStatus?(
    post: ScheduledPostWithMedia,
    account: ConnectedAccount
  ): Promise<PublishStatus>;

  /**
   * Undo a natively-scheduled post. Without this, deleting our row would leave
   * the platform to publish anyway — so the UI's cancel button depends on it.
   */
  cancel?(
    post: ScheduledPostWithMedia,
    account: ConnectedAccount
  ): Promise<void>;

  /**
   * Push an edit to a post the platform is already holding
   * (`SCHEDULED_REMOTE`). Only meaningful for natively-scheduled platforms;
   * queued platforms are edited in our database alone because nothing has been
   * sent yet.
   *
   * `post` is the ALREADY-UPDATED record, so the adapter reads the new values
   * straight off it. Implementations must throw rather than partially apply —
   * the caller only commits the row once this resolves.
   */
  update?(
    post: ScheduledPostWithMedia,
    account: ConnectedAccount
  ): Promise<void>;
}

/**
 * Failure with a retry verdict attached.
 *
 * Only the adapter can read its own platform's error codes, so classification
 * happens there and the worker just honours `retryable`. Getting this backwards
 * is expensive in both directions: retrying a policy rejection spams the
 * platform, and not retrying a 503 loses the post.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly options: {
      /** The credential is dead — mark the account NEEDS_REAUTH, don't retry. */
      needsReauth?: boolean;
      /** Raw platform response, already scrubbed, for PublishJobLog. */
      responseSnippet?: string;
    } = {}
  ) {
    super(message);
    this.name = "PublishError";
  }
}

/** Which post types each platform accepts, for validation at schedule time. */
export const MEDIA_TYPE_BY_PLATFORM: Record<
  SocialPlatform,
  ReadonlyArray<ScheduledPost["mediaType"]>
> = {
  INSTAGRAM: ["REEL", "IMAGE", "CAROUSEL"],
  YOUTUBE: ["SHORT"],
  TIKTOK: ["TIKTOK_VIDEO"],
  FACEBOOK_PAGE: ["FACEBOOK_REEL", "FACEBOOK_VIDEO"],
};

/**
 * How many files each post type takes, and of what kind.
 *
 * Enforced at the API before anything is written, because the alternative is
 * discovering the mismatch at the scheduled minute. Instagram's carousel bounds
 * are the platform's: "up to 10 images, videos, or a mix of the two". The
 * minimum of 2 is ours — Meta documents no floor (see Q14).
 */
export const MEDIA_SHAPE_BY_POST_TYPE: Record<
  ScheduledPost["mediaType"],
  { minItems: number; maxItems: number; kinds: ReadonlyArray<"IMAGE" | "VIDEO"> }
> = {
  REEL: { minItems: 1, maxItems: 1, kinds: ["VIDEO"] },
  IMAGE: { minItems: 1, maxItems: 1, kinds: ["IMAGE"] },
  CAROUSEL: { minItems: 2, maxItems: 10, kinds: ["IMAGE", "VIDEO"] },
  SHORT: { minItems: 1, maxItems: 1, kinds: ["VIDEO"] },
  TIKTOK_VIDEO: { minItems: 1, maxItems: 1, kinds: ["VIDEO"] },
  FACEBOOK_REEL: { minItems: 1, maxItems: 1, kinds: ["VIDEO"] },
  FACEBOOK_VIDEO: { minItems: 1, maxItems: 1, kinds: ["VIDEO"] },
};
