/**
 * Daily quota and post-count tracking.
 *
 * Two different problems live here:
 *
 *  - **YouTube** gives no pre-flight endpoint, so we count units ourselves.
 *    `videos.insert` costs 1,600 units against a 10,000/day project default —
 *    roughly six uploads a day for the entire installation, across all
 *    workspaces. That is a product constraint, so the composer refuses to
 *    schedule past it rather than letting the worker fail at 3 a.m.
 *
 *  - **Instagram** *does* have a pre-flight endpoint
 *    (`content_publishing_limit`), so we ask Instagram instead of guessing —
 *    Meta's docs have contradicted themselves on the number.
 *
 * TikTok and Facebook counts are recorded for visibility; their real caps are
 * enforced by the platform and surface as specific errors.
 */

import type { SocialPlatform } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getYouTubeDailyQuotaUnits } from "@/lib/env";

/** Cost of a single `videos.insert`, per Google's quota calculator. */
export const YOUTUBE_UPLOAD_UNIT_COST = 1600;
/** Cost of `videos.update`, used for cancel/reschedule. */
export const YOUTUBE_UPDATE_UNIT_COST = 50;

/** Quotas reset on UTC midnight, matching how the platforms define the day. */
export function utcDayStart(date: Date = new Date()): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

export async function recordQuotaUsage(params: {
  platform: SocialPlatform;
  connectedAccountId?: string | null;
  units?: number;
  posts?: number;
  at?: Date;
}): Promise<void> {
  const date = utcDayStart(params.at);
  const units = params.units ?? 0;
  const posts = params.posts ?? 0;
  // Project-wide rows (YouTube) use a null account. Prisma treats null as
  // distinct in a compound unique, so upsert-by-where is unreliable here;
  // find-then-write keeps it explicit.
  const connectedAccountId = params.connectedAccountId ?? null;

  const existing = await prisma.platformQuotaUsage.findFirst({
    where: { platform: params.platform, connectedAccountId, date },
    select: { id: true },
  });

  if (existing) {
    await prisma.platformQuotaUsage.update({
      where: { id: existing.id },
      data: {
        unitsUsed: { increment: units },
        postsCount: { increment: posts },
      },
    });
    return;
  }

  await prisma.platformQuotaUsage.create({
    data: {
      platform: params.platform,
      connectedAccountId,
      date,
      unitsUsed: units,
      postsCount: posts,
    },
  });
}

export async function getYouTubeUnitsUsedToday(at?: Date): Promise<number> {
  const date = utcDayStart(at);
  const rows = await prisma.platformQuotaUsage.findMany({
    where: { platform: "YOUTUBE", date },
    select: { unitsUsed: true },
  });
  return rows.reduce((sum, row) => sum + row.unitsUsed, 0);
}

export interface YouTubeQuotaState {
  used: number;
  limit: number;
  remainingUploads: number;
  /** Uploads already committed to a future time today, counted against quota. */
  canUpload: boolean;
}

/**
 * Quota state for the composer and the worker.
 *
 * `pendingUploads` matters: YouTube uploads happen at *schedule* time, so posts
 * already queued for later today have not spent their units yet. Counting them
 * prevents overcommitting the day's budget.
 */
export async function getYouTubeQuotaState(
  at?: Date
): Promise<YouTubeQuotaState> {
  const limit = getYouTubeDailyQuotaUnits();
  const used = await getYouTubeUnitsUsedToday(at);
  const remainingUnits = Math.max(0, limit - used);
  const remainingUploads = Math.floor(
    remainingUnits / YOUTUBE_UPLOAD_UNIT_COST
  );

  return {
    used,
    limit,
    remainingUploads,
    canUpload: remainingUploads > 0,
  };
}

export async function getPostsToday(
  platform: SocialPlatform,
  connectedAccountId: string,
  at?: Date
): Promise<number> {
  const date = utcDayStart(at);
  const row = await prisma.platformQuotaUsage.findFirst({
    where: { platform, connectedAccountId, date },
    select: { postsCount: true },
  });
  return row?.postsCount ?? 0;
}
