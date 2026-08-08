import { NextRequest, NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getBaseUrl, isUnifiedInstagramConnectEnabled } from "@/lib/env";
import {
  createOAuthState,
  getAuthorizationUrl,
  getInstagramConnectScopes,
} from "@/lib/meta/oauth";

/**
 * Starts an Instagram authorization.
 *
 * By default this is the ONLY Instagram connect a user needs: it requests the
 * messaging scopes for comment→DM *and* the publishing scope the scheduler
 * needs, so one consent screen covers both features. The callback writes both
 * rows.
 *
 * `?publish=0` requests messaging only. That is the escape hatch for when the
 * publishing permission is not approved on the Meta app yet — a consent screen
 * containing an unapproved permission fails outright for non-tester users, and
 * comment→DM must never be blocked by a feature the user may not even use.
 * `IG_UNIFIED_CONNECT=0` makes messaging-only the default instead, restoring
 * the old split where publishing is connected separately on Connections.
 */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.redirect(`${getBaseUrl()}/login`);
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/connections?instagram=forbidden`);
  }

  const optedOut = request.nextUrl.searchParams.get("publish") === "0";
  const includePublishing = isUnifiedInstagramConnectEnabled() && !optedOut;

  const redirectUri = `${getBaseUrl()}/api/instagram/callback`;
  const state = createOAuthState(context.workspaceId, includePublishing);

  return NextResponse.redirect(
    getAuthorizationUrl(
      redirectUri,
      state,
      getInstagramConnectScopes(includePublishing)
    )
  );
}
