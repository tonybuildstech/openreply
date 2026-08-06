/**
 * Adapter registry. The only place that maps a platform to its implementation.
 */

import type { SocialPlatform } from "@/app/generated/prisma/client";
import { facebookAdapter } from "@/lib/scheduler/adapters/facebook";
import { instagramAdapter } from "@/lib/scheduler/adapters/instagram";
import { tiktokAdapter } from "@/lib/scheduler/adapters/tiktok";
import { youtubeAdapter } from "@/lib/scheduler/adapters/youtube";
import type { DispatchMode, PublishAdapter } from "@/lib/scheduler/types";

const ADAPTERS: Record<SocialPlatform, PublishAdapter> = {
  INSTAGRAM: instagramAdapter,
  YOUTUBE: youtubeAdapter,
  FACEBOOK_PAGE: facebookAdapter,
  TIKTOK: tiktokAdapter,
};

export function getAdapter(platform: SocialPlatform): PublishAdapter {
  return ADAPTERS[platform];
}

export function getDispatchMode(platform: SocialPlatform): DispatchMode {
  return ADAPTERS[platform].dispatchMode;
}

/**
 * Platforms our worker fires at the scheduled minute, because they have no
 * scheduling parameter. This is the fire-time poll's filter — derived from the
 * adapters themselves so it cannot drift out of sync with them.
 */
export const QUEUED_PLATFORMS: SocialPlatform[] = (
  Object.keys(ADAPTERS) as SocialPlatform[]
).filter((platform) => ADAPTERS[platform].dispatchMode === "QUEUED");

export const NATIVE_PLATFORMS: SocialPlatform[] = (
  Object.keys(ADAPTERS) as SocialPlatform[]
).filter((platform) => ADAPTERS[platform].dispatchMode === "NATIVE");
