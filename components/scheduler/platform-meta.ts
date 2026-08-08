/**
 * Display metadata for the four publishing platforms.
 *
 * `schedulingNote` is not decoration: on two of these platforms "scheduled"
 * means something different from what a user assumes, and the composer says so
 * rather than letting them find out later.
 */

import type { ScheduledPostMediaType } from "@/app/generated/prisma/client";
import {
  CAROUSEL_MAX_ITEMS,
  TIKTOK_PHOTO_MAX_ITEMS,
  TIKTOK_PHOTO_MIN_ITEMS,
} from "@/lib/scheduler/types";

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
    // Like Instagram's, these are DERIVED from the files rather than offered as
    // a menu — and they are two different endpoints, not two labels for one.
    mediaTypes: [
      { value: "TIKTOK_VIDEO", label: "Video" },
      { value: "TIKTOK_PHOTO", label: "Photo carousel" },
    ],
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
  if (platform === "TIKTOK") {
    // Stills and video go to different endpoints, so this is not cosmetic: get
    // it wrong and the adapter builds a chunked upload body for a photo set.
    return kinds.length > 0 && kinds.every((kind) => kind === "IMAGE")
      ? "TIKTOK_PHOTO"
      : "TIKTOK_VIDEO";
  }
  if (platform === "FACEBOOK_PAGE") {
    // Only two values are valid here, so this narrows rather than trusting
    // whatever string the caller happened to be holding.
    return chosen === "FACEBOOK_VIDEO" ? "FACEBOOK_VIDEO" : "FACEBOOK_REEL";
  }
  return PLATFORM_META[platform].mediaTypes[0].value;
}

/**
 * The most files this platform will take for the current selection.
 *
 * Instagram and TikTok disagree — 10 against 35 — so there is no single
 * composer-wide ceiling any more, and the effective cap is the SMALLEST of the
 * selected platforms'. A number returned here is a promise the API will keep;
 * `validateMediaForPlatform` enforces the same limits server-side.
 */
export function maxItemsFor(
  platform: PlatformKey,
  kinds: ReadonlyArray<"IMAGE" | "VIDEO">
): number {
  if (platform === "INSTAGRAM") return CAROUSEL_MAX_ITEMS;
  if (platform === "TIKTOK") {
    return derivePostType("TIKTOK", kinds) === "TIKTOK_PHOTO"
      ? TIKTOK_PHOTO_MAX_ITEMS
      : 1;
  }
  return 1;
}

/**
 * Why this platform cannot take the current selection, or null.
 *
 * Instagram and TikTok both accept stills and multi-item posts; YouTube and
 * Facebook take exactly one video. Saying so up front is what keeps the fan-out
 * honest — the alternative is a post that publishes one arbitrary frame of a
 * carousel and calls it a success.
 */
export function selectionBlocker(
  platform: PlatformKey,
  kinds: ReadonlyArray<"IMAGE" | "VIDEO">
): string | null {
  if (platform === "INSTAGRAM" || kinds.length === 0) return null;

  const label = PLATFORM_META[platform].label;

  if (platform === "TIKTOK") {
    const images = kinds.filter((kind) => kind === "IMAGE").length;
    const videos = kinds.length - images;

    // Photos and video are separate endpoints with separate bodies. There is no
    // documented way to put a video inside a photo carousel.
    if (images > 0 && videos > 0) {
      return `${label} takes either photos or one video in a post, not both.`;
    }
    if (videos > 1) {
      return `${label} publishes one video per post.`;
    }
    if (images > 0 && images < TIKTOK_PHOTO_MIN_ITEMS) {
      // Ours, not TikTok's: the docs state no floor, so we hold to the value we
      // can defend until `.dev/probe-tiktok-photo.ts` settles it.
      return `A ${label} photo post needs at least ${TIKTOK_PHOTO_MIN_ITEMS} photos.`;
    }
    if (images > TIKTOK_PHOTO_MAX_ITEMS) {
      return `${label} takes at most ${TIKTOK_PHOTO_MAX_ITEMS} photos in one post.`;
    }
    return null;
  }

  if (kinds.length > 1) {
    return `${label} takes a single video — schedule the carousel to Instagram or TikTok on its own.`;
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
