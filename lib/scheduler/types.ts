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
  SocialPlatform,
} from "@/app/generated/prisma/client";

export type DispatchMode = "NATIVE" | "QUEUED";

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
    post: ScheduledPost,
    account: ConnectedAccount
  ): Promise<PublishResult>;

  /** Confirm a post that the platform processes asynchronously. */
  checkStatus?(
    post: ScheduledPost,
    account: ConnectedAccount
  ): Promise<PublishStatus>;

  /**
   * Undo a natively-scheduled post. Without this, deleting our row would leave
   * the platform to publish anyway — so the UI's cancel button depends on it.
   */
  cancel?(post: ScheduledPost, account: ConnectedAccount): Promise<void>;
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

/** Which media types each platform accepts, for validation at schedule time. */
export const MEDIA_TYPE_BY_PLATFORM: Record<
  SocialPlatform,
  ReadonlyArray<ScheduledPost["mediaType"]>
> = {
  INSTAGRAM: ["REEL"],
  YOUTUBE: ["SHORT"],
  TIKTOK: ["TIKTOK_VIDEO"],
  FACEBOOK_PAGE: ["FACEBOOK_REEL", "FACEBOOK_VIDEO"],
};
