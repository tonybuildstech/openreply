/**
 * Display metadata for the four publishing platforms.
 *
 * `schedulingNote` is not decoration: on two of these platforms "scheduled"
 * means something different from what a user assumes, and the composer says so
 * rather than letting them find out later.
 */

import type { ScheduledPostMediaType } from "@/app/generated/prisma/client";

export type PlatformKey =
  | "INSTAGRAM"
  | "YOUTUBE"
  | "FACEBOOK_PAGE"
  | "TIKTOK";

export interface PlatformMeta {
  label: string;
  slug: string;
  /** Post types this platform can produce. */
  mediaTypes: Array<{ value: ScheduledPostMediaType; label: string }>;
  /** Who holds the timer. */
  scheduling: "native" | "worker";
  schedulingNote: string;
}

export const PLATFORM_META: Record<PlatformKey, PlatformMeta> = {
  INSTAGRAM: {
    label: "Instagram",
    slug: "instagram",
    // Not a menu: which of these a post becomes is DERIVED from the files
    // chosen (see `derivePostType`). Offering it as a choice would let the user
    // pick a shape their files cannot satisfy.
    mediaTypes: [
      { value: "REEL", label: "Reel" },
      { value: "IMAGE", label: "Photo" },
      { value: "CAROUSEL", label: "Carousel" },
    ],
    scheduling: "worker",
    schedulingNote:
      "Instagram has no scheduling API. OpenReply's worker publishes this at the scheduled minute, so the worker must be running.",
  },
  YOUTUBE: {
    label: "YouTube",
    slug: "youtube",
    mediaTypes: [{ value: "SHORT", label: "Short" }],
    scheduling: "native",
    schedulingNote:
      "YouTube holds the schedule. The video uploads immediately and goes public at the chosen time.",
  },
  FACEBOOK_PAGE: {
    label: "Facebook Page",
    slug: "facebook",
    mediaTypes: [
      { value: "FACEBOOK_REEL", label: "Reel" },
      { value: "FACEBOOK_VIDEO", label: "Feed video" },
    ],
    scheduling: "native",
    schedulingNote:
      "Facebook holds the schedule. The video uploads immediately and posts at the chosen time.",
  },
  TIKTOK: {
    label: "TikTok",
    slug: "tiktok",
    mediaTypes: [{ value: "TIKTOK_VIDEO", label: "Video" }],
    scheduling: "worker",
    schedulingNote:
      "TikTok has no scheduling API. OpenReply's worker uploads at the scheduled minute, so the worker must be running.",
  },
};

/**
 * The post type a set of files produces on a platform.
 *
 * Instagram's shape follows entirely from the files: two or more items is a
 * carousel, one still is a photo, one video is a Reel. Deriving it rather than
 * offering a selector is what stops the composer presenting a combination it
 * cannot build — picking "Carousel" with one file selected would be a promise
 * the API rejects.
 *
 * Facebook is the one genuine choice: a single video can be a Reel or a feed
 * video, and only the user knows which they want.
 */
export function derivePostType(
  platform: PlatformKey,
  kinds: ReadonlyArray<"IMAGE" | "VIDEO">,
  chosen?: string
): ScheduledPostMediaType {
  if (platform === "INSTAGRAM") {
    if (kinds.length > 1) return "CAROUSEL";
    return kinds[0] === "IMAGE" ? "IMAGE" : "REEL";
  }
  if (platform === "FACEBOOK_PAGE") {
    // Only two values are valid here, so this narrows rather than trusting
    // whatever string the caller happened to be holding.
    return chosen === "FACEBOOK_VIDEO" ? "FACEBOOK_VIDEO" : "FACEBOOK_REEL";
  }
  return PLATFORM_META[platform].mediaTypes[0].value;
}

/**
 * Why this platform cannot take the current selection, or null.
 *
 * Only Instagram accepts a still or more than one file. Saying so up front is
 * what keeps the fan-out honest — the alternative is a post that publishes one
 * arbitrary frame of a carousel to TikTok and calls it a success.
 */
export function selectionBlocker(
  platform: PlatformKey,
  kinds: ReadonlyArray<"IMAGE" | "VIDEO">
): string | null {
  if (platform === "INSTAGRAM" || kinds.length === 0) return null;

  const label = PLATFORM_META[platform].label;
  if (kinds.length > 1) {
    return `${label} takes a single video — schedule the carousel to Instagram on its own.`;
  }
  if (kinds[0] === "IMAGE") {
    return `${label} does not accept photos through the API, only video.`;
  }
  return null;
}

export const PLATFORM_ORDER: PlatformKey[] = [
  "INSTAGRAM",
  "TIKTOK",
  "YOUTUBE",
  "FACEBOOK_PAGE",
];

export const POST_STATUS_LABELS: Record<
  string,
  { label: string; text: string }
> = {
  QUEUED: { label: "Queued", text: "text-warning" },
  UPLOADING: { label: "Uploading", text: "text-warning" },
  PUBLISHING: { label: "Publishing", text: "text-warning" },
  SCHEDULED_REMOTE: { label: "Scheduled", text: "text-muted" },
  PUBLISHED: { label: "Published", text: "text-success" },
  FAILED: { label: "Failed", text: "text-error" },
  CANCELED: { label: "Cancelled", text: "text-muted" },
};
