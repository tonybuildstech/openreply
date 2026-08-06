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

import type { SocialPlatform } from "@/app/generated/prisma/client";

export interface PlatformConstraints {
  /** Accepted container MIME types. */
  mimeTypes: readonly string[];
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  maxFileBytes?: number;
  minFrameRate?: number;
  maxFrameRate?: number;
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

export const PLATFORM_CONSTRAINTS: Record<SocialPlatform, PlatformConstraints> =
  {
    // Reels specs are only partially documented — Meta's own reference is
    // truncated on bitrate and exact duration. Treat these as the floor of what
    // we know, and let the API reject the rest.
    INSTAGRAM: {
      mimeTypes: ["video/mp4"],
      minDurationSeconds: 3,
      maxDurationSeconds: 90,
      maxFileBytes: 1 * GB,
      maxFrameRate: 60,
      dailyPostCap: 25,
      // No native scheduling: our worker fires it. A short lead time is fine,
      // but the upload + container processing needs room before the target.
      minLeadTimeMinutes: 5,
      maxLeadTimeDays: 365,
      notes: [
        "Instagram has no scheduling API — OpenReply's worker publishes this at the scheduled minute.",
        "Limit: 25 posts per rolling 24 hours, checked against Instagram before each publish.",
      ],
    },

    // Documented: 1,600 quota units per upload against a 10,000/day project
    // default. The per-day upload ceiling is enforced in lib/scheduler/quota.ts.
    YOUTUBE: {
      mimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
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
      mimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
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
      mimeTypes: ["video/mp4"],
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

export function validateMediaForPlatform(
  platform: SocialPlatform,
  media: { mimeType: string; sizeBytes: number }
): string | null {
  const constraints = PLATFORM_CONSTRAINTS[platform];

  if (!constraints.mimeTypes.includes(media.mimeType)) {
    return `This platform accepts ${constraints.mimeTypes.join(", ")} — your file is ${media.mimeType}`;
  }

  if (constraints.maxFileBytes && media.sizeBytes > constraints.maxFileBytes) {
    const limitGb = (constraints.maxFileBytes / GB).toFixed(1);
    return `File is larger than this platform's ${limitGb} GB limit`;
  }

  return null;
}
