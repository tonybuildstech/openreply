import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { queryCreatorInfo } from "@/lib/scheduler/adapters/tiktok";
import { resolveAccessToken } from "@/lib/scheduler/tokens";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Live posting settings for one connected TikTok account.
 *
 * TikTok requires the composer to render privacy options and interaction
 * toggles from `creator_info` rather than a hardcoded list: the options are
 * per-creator and mutable. A private account is never offered
 * `PUBLIC_TO_EVERYONE` and gets `FOLLOWER_OF_CREATOR` instead — so a hardcoded
 * list both hides a level the creator can use and offers one they cannot, which
 * fails at publish with `privacy_level_option_mismatch` long after scheduling.
 *
 * Proxied through our own route rather than called from the browser because the
 * access token is encrypted at rest and must never reach the client.
 *
 * Errors are returned as a normal 200 with `success: false` and a readable
 * message: the composer treats missing creator info as "fall back to the safe
 * defaults and warn", not as a page-breaking failure — TikTok is a third party
 * and being down should not block scheduling to other platforms.
 */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const connectedAccountId = request.nextUrl.searchParams.get(
    "connectedAccountId"
  );
  if (!connectedAccountId) {
    return NextResponse.json(
      { success: false, error: "connectedAccountId is required" },
      { status: 400 }
    );
  }

  const account = await prisma.connectedAccount.findFirst({
    where: {
      id: connectedAccountId,
      workspaceId: context.workspaceId,
      platform: "TIKTOK",
    },
  });

  if (!account) {
    return NextResponse.json(
      { success: false, error: "TikTok account not found" },
      { status: 404 }
    );
  }

  try {
    const accessPlaintextToken = await resolveAccessToken(account);
    const info = await queryCreatorInfo(accessPlaintextToken);
    return NextResponse.json({ success: true, data: info });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not reach TikTok for this account's settings.",
    });
  }
}
