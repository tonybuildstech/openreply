/** Shared composer types. */

import type { PlatformKey } from "@/components/scheduler/platform-meta";

export interface TikTokTargetOptions {
  privacyLevel?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
}

export interface YouTubeTargetOptions {
  title?: string;
  description?: string;
}

export interface InstagramTargetOptions {
  shareToFeed?: boolean;
}

export type TargetOptions = TikTokTargetOptions &
  YouTubeTargetOptions &
  InstagramTargetOptions;

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
