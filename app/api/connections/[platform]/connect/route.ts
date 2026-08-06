import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/env";
import { getOAuthProvider } from "@/lib/scheduler/oauth/providers";
import { PLATFORM_BY_SLUG, createConnectionState } from "@/lib/scheduler/oauth/state";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Kick off a publishing connection: `/api/connections/{platform}/connect`.
 *
 * Deliberately separate from `/api/instagram/connect`, which requests the
 * messaging scopes for the comment→DM feature. Different scopes, different App
 * Review track — the two connections are independent by design and must not be
 * merged into one consent screen.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ platform: string }> }
) {
  const { platform: slug } = await ctx.params;
  const platform = PLATFORM_BY_SLUG[slug];
  const baseUrl = getBaseUrl();

  if (!platform) {
    return NextResponse.redirect(`${baseUrl}/scheduler?error=unknown_platform`);
  }

  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${baseUrl}/scheduler?error=forbidden`);
  }

  try {
    const state = createConnectionState(context.workspaceId, platform);
    return NextResponse.redirect(
      getOAuthProvider(platform).authorizationUrl(state)
    );
  } catch (error) {
    // Almost always a missing credential env var for this platform.
    console.error(`[Connections] ${slug} authorize failed:`, error);
    return NextResponse.redirect(
      `${baseUrl}/scheduler?error=not_configured&platform=${slug}`
    );
  }
}
