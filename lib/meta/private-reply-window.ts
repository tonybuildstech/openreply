/**
 * Instagram's two hard limits on private replies (comment→DM).
 *
 * Both are enforced by Meta, not by us, and both were previously unmodelled —
 * we would attempt the send, Meta would reject it, and the job would burn its
 * retries. Confirmed 2026-08-08:
 * `.dev/research/meta-graph-api/findings/2026-08-08.md`.
 *
 *  1. **One private reply per comment.** Not one per campaign — one per
 *     *comment*, full stop. Two campaigns matching the same comment is a normal
 *     configuration (a post-specific campaign plus a match-any-post one), so
 *     this has to be enforced across campaigns, not inside one.
 *
 *  2. **Seven days from the comment's creation.** After that the comment can
 *     still be replied to publicly, but the private reply is gone for good.
 *     (Instagram Live is stricter still — only during the broadcast — which we
 *     do not model, because we never act on live comments.)
 *
 * Source: developers.facebook.com/docs/messenger-platform/instagram/features/private-replies/
 */

export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The same window in hours, for bounding the polling reconciler's lookback. */
export const PRIVATE_REPLY_WINDOW_HOURS = 7 * 24;

/**
 * Whether a comment created at `createdAt` can still receive a private reply.
 *
 * Unknown creation time returns `true`: the pre-existing behavior was to always
 * attempt the send, and refusing to send because we failed to record a
 * timestamp would turn a missing field into lost DMs. Meta remains the
 * authority — this only avoids calls that are certain to fail.
 */
export function isWithinPrivateReplyWindow(
  createdAt: Date | string | null | undefined,
  now: Date = new Date()
): boolean {
  if (createdAt === null || createdAt === undefined) return true;

  const createdMs =
    createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return true;

  return now.getTime() - createdMs < PRIVATE_REPLY_WINDOW_MS;
}

/** How far past the window a comment is, for a log message a human can act on. */
export function describePrivateReplyWindowExpiry(
  createdAt: Date | string,
  now: Date = new Date()
): string {
  const createdMs =
    createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  const ageDays = Math.floor((now.getTime() - createdMs) / (24 * 60 * 60 * 1000));

  return `Outside Instagram's 7-day private-reply window (comment is ${ageDays} days old). Instagram rejects private replies to comments older than 7 days.`;
}
