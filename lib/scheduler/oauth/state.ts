/**
 * Signed OAuth state for scheduler connections.
 *
 * Same construction as `lib/meta/oauth.ts` — HMAC over a base64url payload with
 * a 10-minute lifetime — but it also carries the platform, because all four
 * providers share one callback route shape and the callback must know which
 * provider it is completing without trusting a query parameter.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { SocialPlatform } from "@/app/generated/prisma/client";
import { requireEnv } from "@/lib/env";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface SchedulerStatePayload {
  workspaceId: string;
  platform: SocialPlatform;
  ts: number;
}

function sign(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(payload)
    .digest("base64url");
}

export function createConnectionState(
  workspaceId: string,
  platform: SocialPlatform
): string {
  const payload = Buffer.from(
    JSON.stringify({
      workspaceId,
      platform,
      ts: Date.now(),
    } satisfies SchedulerStatePayload)
  ).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

export function verifyConnectionState(
  state: string | null
): SchedulerStatePayload | null {
  if (!state) return null;

  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as SchedulerStatePayload;

    if (
      !parsed.workspaceId ||
      !parsed.platform ||
      Date.now() - parsed.ts > STATE_MAX_AGE_MS
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** URL slug ↔ enum. The slug is part of the registered redirect URI. */
export const PLATFORM_BY_SLUG: Record<string, SocialPlatform> = {
  instagram: "INSTAGRAM",
  youtube: "YOUTUBE",
  facebook: "FACEBOOK_PAGE",
  tiktok: "TIKTOK",
};

export const SLUG_BY_PLATFORM: Record<SocialPlatform, string> = {
  INSTAGRAM: "instagram",
  YOUTUBE: "youtube",
  FACEBOOK_PAGE: "facebook",
  TIKTOK: "tiktok",
};
