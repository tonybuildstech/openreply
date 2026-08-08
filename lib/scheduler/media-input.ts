/**
 * The shape of one media item as the client may describe it.
 *
 * Shared by the create and patch routes on purpose. They each kept their own
 * copy of this until now, and the two drifted the last time one was widened —
 * producing an API that accepted a field on create and rejected it on edit.
 *
 * **Deliberately minimal.** Only the storage key and what the BROWSER knows
 * that the server cannot cheaply learn. MIME type, size and kind are read back
 * from storage rather than accepted here: a client that could declare its own
 * kind could label a video as an image and route it down Instagram's
 * `image_url` path, which fails as an opaque container ERROR ten minutes later.
 */

import { z } from "zod";

/**
 * Instagram's documented ceiling on people tagged in one photo.
 *
 * Ours to enforce, because exceeding it is a container rejection at the
 * scheduled minute rather than a truncation.
 */
export const MAX_TAGS_PER_ITEM = 20;

/** Instagram usernames: letters, digits, dots and underscores, max 30. */
const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  // A leading @ is allowed because people type it; `normaliseUserTags` strips
  // it. Rejecting it here would fail a request over punctuation we discard.
  .regex(
    /^@?[A-Za-z0-9._]+$/,
    "Instagram usernames use letters, numbers, dots and underscores"
  );

/**
 * One tagged person.
 *
 * `x`/`y` are fractions of the image from the top-left. Meta documents image
 * tags as `{username, x, y}` and video tags as `{username}` alone, so the
 * coordinates are optional here and the adapter drops them for video.
 */
export const userTagSchema = z.object({
  username: usernameSchema,
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
});

export type MediaUserTagInput = z.infer<typeof userTagSchema>;

export const mediaItemSchema = z.object({
  storageKey: z.string().min(1),
  /** Probed from an <img>/<video> element; absent when probing failed. */
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** e.g. "PORTRAIT" when the user accepted a crop. Absent = untouched original. */
  croppedToRatio: z.string().max(16).optional(),
  /** People tagged in THIS item. Per item, because Instagram tags per photo. */
  userTags: z.array(userTagSchema).max(MAX_TAGS_PER_ITEM).optional(),
});

export type MediaItemInput = z.infer<typeof mediaItemSchema>;

/**
 * Normalise tags for storage: trim, strip a leading @, drop duplicates.
 *
 * Returns null for "nobody", so the column stays NULL rather than holding an
 * empty array — one representation of absence beats two.
 */
export function normaliseUserTags(
  tags: MediaUserTagInput[] | undefined
): MediaUserTagInput[] | null {
  if (!tags || tags.length === 0) return null;

  const seen = new Set<string>();
  const unique: MediaUserTagInput[] = [];

  for (const tag of tags) {
    const username = tag.username.trim().replace(/^@/, "").toLowerCase();
    if (!username || seen.has(username)) continue;
    seen.add(username);
    unique.push({ ...tag, username });
  }

  return unique.length > 0 ? unique : null;
}
