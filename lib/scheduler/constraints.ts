/**
 * Per-platform media and scheduling constraints.
 *
 * Every number here traces to the research round of 2026-08-06/09
 * (`.dev/changes/implement-multi-platform-scheduler/research/`). Values the
 * platform documents are marked `documented`; values the docs leave silent are
 * marked `assumed` with a reason. We validate against these rather than
 * transcoding — the user is warned or refused before scheduling, never
 * silently re-encoded.
 */

import type {
  ScheduledPostMediaType,
  SocialPlatform,
} from "@/app/generated/prisma/client";
// Ratio naming lives with the rest of the aspect maths so the composer and
// this validator cannot disagree about what "4:5" means.
import { describeRatio } from "@/lib/media/aspect";
import { MEDIA_SHAPE_BY_POST_TYPE } from "@/lib/scheduler/types";

export interface PlatformConstraints {
  /** Accepted video container MIME types. */
  videoMimeTypes: readonly string[];
  /** Accepted still-image MIME types. Empty means the platform takes no stills. */
  imageMimeTypes: readonly string[];
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  maxFileBytes?: number;
  /** Separate from `maxFileBytes` — platforms cap stills far lower than video. */
  maxImageBytes?: number;
  minFrameRate?: number;
  maxFrameRate?: number;
  /**
   * Accepted still aspect ratios as width/height.
   *
   * Only set where the platform **rejects** out-of-range images rather than
   * cropping them, which is what makes checking worth doing at all: Instagram
   * errors the container, and that error lands in the worker at the scheduled
   * minute with nobody watching.
   */
  imageAspectRatioRange?: { min: number; max: number };
  /** Set only for platforms that accept multi-item posts. */
  carousel?: {
    minItems: number;
    maxItems: number;
    allowsVideo: boolean;
  };
  /** Rolling-24h publish cap, where the platform documents one. */
  dailyPostCap?: number;
  /** Minimum lead time we require between "now" and the scheduled minute. */
  minLeadTimeMinutes: number;
  /** Maximum distance into the future we accept. */
  maxLeadTimeDays: number;
  /** Caveats worth showing in the composer. */
  notes: readonly string[];
}

const GB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

export const PLATFORM_CONSTRAINTS: Record<SocialPlatform, PlatformConstraints> =
  {
    // Reels specs are only partially documented — Meta's own reference is
    // truncated on bitrate and exact duration. Treat these as the floor of what
    // we know, and let the API reject the rest.
    INSTAGRAM: {
      videoMimeTypes: ["video/mp4"],
      // JPEG only, deliberately. Meta publishes NO list of accepted image
      // formats for content publishing (research 2026-08-08) — "JPEG only" is
      // integrator folklore, and PNG is reported failing at container creation
      // as often as working. Accepting a format we cannot defend would turn a
      // clear error here into an opaque container ERROR at the scheduled
      // minute. Widen once `.dev/probe-ig-params.ts` probes 3–4 settle it.
      imageMimeTypes: ["image/jpeg"],
      minDurationSeconds: 3,
      maxDurationSeconds: 90,
      maxFileBytes: 1 * GB,
      // Documented via Meta's error-code reference: "Image exceeded maximum
      // file size of 8 MiB."
      maxImageBytes: 8 * MIB,
      // Documented: "try again with an image that falls within a 4:5 to 1.91:1
      // range". Instagram REJECTS outside this — it does not crop.
      imageAspectRatioRange: { min: 0.8, max: 1.91 },
      carousel: { minItems: 2, maxItems: 10, allowsVideo: true },
      maxFrameRate: 60,
      // Documented at 50 per rolling 24h per account (research 2026-08-08); was
      // 25 here, which disagreed with Meta's own guide. A carousel counts as
      // ONE published item however many children it has — worth saying in the
      // note below once the composer can actually build one.
      dailyPostCap: 50,
      // No native scheduling: our worker fires it. A short lead time is fine,
      // but the upload + container processing needs room before the target.
      minLeadTimeMinutes: 5,
      maxLeadTimeDays: 365,
      notes: [
        "Instagram has no scheduling API — OpenReply's worker publishes this at the scheduled minute.",
        "Limit: 50 posts per rolling 24 hours, checked against Instagram before each publish.",
      ],
    },

    // Documented: 1,600 quota units per upload against a 10,000/day project
    // default. The per-day upload ceiling is enforced in lib/scheduler/quota.ts.
    YOUTUBE: {
      videoMimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
      imageMimeTypes: [],
      maxDurationSeconds: 180,
      maxFileBytes: 256 * GB,
      // Google documents no minimum lead time, but developers report
      // invalidVideoMetadata when scheduling very close to now.
      minLeadTimeMinutes: 60,
      maxLeadTimeDays: 365,
      notes: [
        "YouTube holds the schedule itself — the video uploads now and goes public at the chosen time.",
        "There is no API flag for Shorts: YouTube decides from aspect ratio and duration.",
        "Uploads cost 1,600 of the project's 10,000 daily quota units — about 6 per day in total.",
      ],
    },

    // Fully documented in TikTok's media transfer guide.
    TIKTOK: {
      videoMimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
      imageMimeTypes: [],
      maxDurationSeconds: 600,
      maxFileBytes: 4 * GB,
      minFrameRate: 23,
      maxFrameRate: 60,
      dailyPostCap: 15,
      minLeadTimeMinutes: 5,
      maxLeadTimeDays: 365,
      notes: [
        "TikTok has no scheduling API — OpenReply's worker uploads at the scheduled minute.",
        "Around 15 posts per creator per 24 hours, shared across every app that posts for them.",
      ],
    },

    // Reels specs are fully documented; plain feed video is not.
    FACEBOOK_PAGE: {
      videoMimeTypes: ["video/mp4"],
      imageMimeTypes: [],
      minDurationSeconds: 3,
      maxDurationSeconds: 90,
      maxFileBytes: 4 * GB,
      minFrameRate: 24,
      maxFrameRate: 60,
      dailyPostCap: 30,
      // Documented: scheduled_publish_time must be at least 10 minutes out.
      minLeadTimeMinutes: 10,
      // The docs contradict themselves — /feed says 75 days, /videos says 6
      // months. We take the conservative one; the API is the final word.
      maxLeadTimeDays: 75,
      notes: [
        "Facebook holds the schedule itself — the video uploads now and posts at the chosen time.",
        "Limit: 30 Reels published through the API per rolling 24 hours.",
        "Duration limits apply to Reels; plain feed video is more permissive but undocumented.",
      ],
    },
  };

export interface ScheduleWindowIssue {
  code: "TOO_SOON" | "TOO_FAR";
  message: string;
}

export function validateScheduleWindow(
  platform: SocialPlatform,
  scheduledAt: Date,
  now: Date = new Date()
): ScheduleWindowIssue | null {
  const constraints = PLATFORM_CONSTRAINTS[platform];
  const minutesAhead = (scheduledAt.getTime() - now.getTime()) / 60_000;

  if (minutesAhead < constraints.minLeadTimeMinutes) {
    return {
      code: "TOO_SOON",
      message: `Schedule at least ${constraints.minLeadTimeMinutes} minutes ahead for this platform`,
    };
  }

  if (minutesAhead > constraints.maxLeadTimeDays * 24 * 60) {
    return {
      code: "TOO_FAR",
      message: `This platform accepts schedules up to ${constraints.maxLeadTimeDays} days ahead`,
    };
  }

  return null;
}

export interface MediaItemForValidation {
  mimeType: string;
  sizeBytes: number;
  kind: "IMAGE" | "VIDEO";
  /** From the browser probe. Null when probing failed — treated as unknown. */
  widthPx?: number | null;
  heightPx?: number | null;
}

/**
 * Whether this post's files can actually be published as this post type.
 *
 * Checks item COUNT and KIND as well as each file, because the two interact:
 * a carousel needs 2–10 items, a Reel needs exactly one video, and Instagram is
 * the only platform that accepts either a still or more than one file.
 *
 * Aspect ratio is checked only for stills, only where the platform rejects
 * rather than crops, and only when the browser managed to probe dimensions.
 * That check is the whole reason this function grew: without it an out-of-range
 * image is accepted here and fails in the worker at the scheduled minute.
 *
 * Returns the first problem in words the user can act on, or null.
 */
export function validateMediaForPlatform(
  platform: SocialPlatform,
  postType: ScheduledPostMediaType,
  items: readonly MediaItemForValidation[]
): string | null {
  const constraints = PLATFORM_CONSTRAINTS[platform];
  const shape = MEDIA_SHAPE_BY_POST_TYPE[postType];

  if (items.length < shape.minItems || items.length > shape.maxItems) {
    return shape.minItems === shape.maxItems
      ? `A ${postType} post takes exactly ${shape.minItems} file — this one has ${items.length}`
      : `A ${postType} post takes between ${shape.minItems} and ${shape.maxItems} files — this one has ${items.length}`;
  }

  for (const [index, item] of items.entries()) {
    // Only worth naming the position when there is more than one.
    const where = items.length > 1 ? `Item ${index + 1}: ` : "";

    if (!shape.kinds.includes(item.kind)) {
      return `${where}a ${postType} post cannot contain ${item.kind === "IMAGE" ? "an image" : "a video"}`;
    }

    if (item.kind === "IMAGE") {
      if (constraints.imageMimeTypes.length === 0) {
        return `${where}this platform does not accept still images`;
      }
      if (!constraints.imageMimeTypes.includes(item.mimeType)) {
        return `${where}this platform accepts ${constraints.imageMimeTypes.join(", ")} images — yours is ${item.mimeType}`;
      }
      if (
        constraints.maxImageBytes &&
        item.sizeBytes > constraints.maxImageBytes
      ) {
        return `${where}image is larger than this platform's ${Math.round(constraints.maxImageBytes / MIB)} MB limit`;
      }

      const range = constraints.imageAspectRatioRange;
      if (range && item.widthPx && item.heightPx) {
        const ratio = item.widthPx / item.heightPx;
        if (ratio < range.min || ratio > range.max) {
          // Named separately from a crop suggestion: this platform REJECTS the
          // container, so the file genuinely has to change before it can post.
          return `${where}this image is ${describeRatio(item.widthPx, item.heightPx)}, outside the 4:5 to 1.91:1 range this platform accepts. Crop it to fit.`;
        }
      }
      continue;
    }

    if (!constraints.videoMimeTypes.includes(item.mimeType)) {
      return `${where}this platform accepts ${constraints.videoMimeTypes.join(", ")} — yours is ${item.mimeType}`;
    }
    if (constraints.maxFileBytes && item.sizeBytes > constraints.maxFileBytes) {
      const limitGb = (constraints.maxFileBytes / GB).toFixed(1);
      return `${where}video is larger than this platform's ${limitGb} GB limit`;
    }
  }

  return null;
}
