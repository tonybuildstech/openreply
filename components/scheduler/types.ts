/**
 * Composer types.
 *
 * Every field here is one the corresponding adapter actually sends. Keep them
 * in sync with `lib/scheduler/adapters/*` — an option the UI collects but no
 * adapter reads is worse than no option at all, because the user believes it
 * took effect.
 */

import type { PlatformKey } from "@/components/scheduler/platform-meta";

export interface InstagramTargetOptions {
  /** Also place the Reel in the main feed grid, not just the Reels tab. */
  shareToFeed?: boolean;
  /** Public URL of a still to use as the cover. Overrides thumbOffset. */
  coverUrl?: string;
  /** Milliseconds into the video to grab the cover frame from. */
  thumbOffset?: number;
  /** Label shown as the audio track name. */
  audioName?: string;
  /** Comma-separated IG usernames invited as collaborators. */
  collaborators?: string;
  /** Facebook Page ID representing the location to tag. */
  locationId?: string;
  /** Comma-separated IG usernames to tag in the Reel. */
  userTags?: string;
}

export interface YouTubeTargetOptions {
  /** Required by YouTube; falls back to the caption's first line. */
  title?: string;
  description?: string;
  /** Comma-separated. */
  tags?: string;
  categoryId?: string;
  /** YouTube requires an audience declaration on every upload. */
  madeForKids?: boolean;
}

export interface TikTokTargetOptions {
  /** TikTok forbids a pre-selected default — the creator must choose. */
  privacyLevel?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  videoCoverTimestampMs?: number;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
}

export interface FacebookTargetOptions {
  /** Feed video only — Reels take the description alone. */
  title?: string;
}

export type TargetOptions = InstagramTargetOptions &
  YouTubeTargetOptions &
  TikTokTargetOptions &
  FacebookTargetOptions;

export interface ComposerAccount {
  id: string;
  platform: PlatformKey;
  displayName: string;
  avatarUrl: string | null;
  status: "ACTIVE" | "NEEDS_REAUTH" | "DISABLED";
  tiktokPostMode: "INBOX" | "DIRECT_POST" | null;
  limitation: string | null;
}

/** One selected account in the composer, with its per-platform overrides. */
export interface ComposerTarget {
  connectedAccountId: string;
  mediaType: string;
  /** Empty means "use the shared caption". */
  caption: string;
  options: TargetOptions;
}

/** YouTube's standard category IDs — the subset creators actually pick. */
export const YOUTUBE_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "22", label: "People & Blogs" },
  { id: "24", label: "Entertainment" },
  { id: "23", label: "Comedy" },
  { id: "10", label: "Music" },
  { id: "20", label: "Gaming" },
  { id: "26", label: "Howto & Style" },
  { id: "27", label: "Education" },
  { id: "28", label: "Science & Technology" },
  { id: "17", label: "Sports" },
  { id: "19", label: "Travel & Events" },
  { id: "15", label: "Pets & Animals" },
  { id: "25", label: "News & Politics" },
];
