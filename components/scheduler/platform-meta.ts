/**
 * Display metadata for the four publishing platforms.
 *
 * `schedulingNote` is not decoration: on two of these platforms "scheduled"
 * means something different from what a user assumes, and the composer says so
 * rather than letting them find out later.
 */

export type PlatformKey =
  | "INSTAGRAM"
  | "YOUTUBE"
  | "FACEBOOK_PAGE"
  | "TIKTOK";

export interface PlatformMeta {
  label: string;
  slug: string;
  /** Media types the composer offers for this platform. */
  mediaTypes: Array<{ value: string; label: string }>;
  /** Who holds the timer. */
  scheduling: "native" | "worker";
  schedulingNote: string;
}

export const PLATFORM_META: Record<PlatformKey, PlatformMeta> = {
  INSTAGRAM: {
    label: "Instagram",
    slug: "instagram",
    mediaTypes: [{ value: "REEL", label: "Reel" }],
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
