import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { encryptOptionalToken, encryptToken } from "@/lib/crypto/token-cipher";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { getOAuthProvider } from "@/lib/scheduler/oauth/providers";
import {
  PLATFORM_BY_SLUG,
  verifyConnectionState,
} from "@/lib/scheduler/oauth/state";
import { canManageWorkspace } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Completes a publishing connection: `/api/connections/{platform}/callback`.
 *
 * Facebook returns every Page the user can publish to, so `completeConnection`
 * yields an array and one authorization can create several accounts. The other
 * three return exactly one.
 *
 * Upserts on (workspaceId, platform, platformAccountId) so re-connecting the
 * same account refreshes its tokens instead of duplicating the row.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ platform: string }> }
) {
  const { platform: slug } = await ctx.params;
  const baseUrl = getBaseUrl();
  const redirectBack = (params: string) =>
    NextResponse.redirect(`${baseUrl}/scheduler/connections?${params}`);

  const platform = PLATFORM_BY_SLUG[slug];
  if (!platform) return redirectBack("error=unknown_platform");

  if (request.nextUrl.searchParams.get("error")) {
    return redirectBack(`error=denied&platform=${slug}`);
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = verifyConnectionState(
    request.nextUrl.searchParams.get("state")
  );
  if (!code || !state || state.platform !== platform) {
    return redirectBack(`error=invalid_state&platform=${slug}`);
  }

  // The signed state proves which workspace started the flow; re-check that the
  // person finishing it is still a member who may manage that workspace.
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return redirectBack(`error=forbidden&platform=${slug}`);
  }

  try {
    const accounts = await getOAuthProvider(platform).completeConnection(code);

    for (const account of accounts) {
      const data = {
        displayName: account.displayName,
        avatarUrl: account.avatarUrl ?? null,
        accessToken: encryptToken(account.accessPlaintextToken),
        refreshToken: encryptOptionalToken(account.refreshPlaintextToken),
        tokenExpiresAt: account.expiresAt ?? null,
        scopes: account.scopes,
        metadata: (account.metadata ?? {}) as object,
        // Reconnecting is how a user clears NEEDS_REAUTH.
        status: "ACTIVE" as const,
      };

      await prisma.connectedAccount.upsert({
        where: {
          workspaceId_platform_platformAccountId: {
            workspaceId: state.workspaceId,
            platform,
            platformAccountId: account.platformAccountId,
          },
        },
        create: {
          workspaceId: state.workspaceId,
          platform,
          platformAccountId: account.platformAccountId,
          ...data,
        },
        update: data,
      });
    }

    return redirectBack(`connected=${slug}&count=${accounts.length}`);
  } catch (error) {
    // The message may name a missing env var or a provider error; it must not
    // reach the browser. Log it server-side and redirect with a plain code.
    console.error(`[Connections] ${slug} callback failed:`, error);
    return redirectBack(`error=failed&platform=${slug}`);
  }
}
