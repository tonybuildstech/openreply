import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import { getLongLivedToken, getUserInfo, subscribeInstagramAccountToWebhooks } from "@/lib/meta/client";
import {
  encryptToken,
  exchangeCodeForToken,
  getInstagramConnectScopes,
  grantedPublishing,
  verifyOAuthState,
} from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  const baseUrl = getBaseUrl();

  if (error) {
    // If this attempt included the publishing scope, tell Connections so it can
    // offer the messaging-only retry. An unapproved publishing permission is
    // the most likely reason a unified consent screen comes back refused, and
    // comment→DM works fine without it.
    return NextResponse.redirect(
      state?.pub
        ? `${baseUrl}/connections?instagram=denied&retry=messaging`
        : `${baseUrl}/connections?instagram=denied`
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/connections?instagram=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: state.workspaceId,
      userId: session.user.id,
    },
  });

  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/connections?instagram=forbidden`);
  }

  try {
    const redirectUri = `${baseUrl}/api/instagram/callback`;
    const { accessToken: shortLivedToken, permissions } =
      await exchangeCodeForToken(code, redirectUri);
    const canPublish = grantedPublishing(Boolean(state.pub), permissions);
    const { accessToken: longLivedToken, expiresIn } =
      await getLongLivedToken(shortLivedToken);
    const userInfo = await getUserInfo(longLivedToken);
    // Webhooks and the messaging API key off the professional account ID
    // (user_id), not the app-scoped `id`. Store user_id so comment webhooks
    // can be matched back to this account. Fall back to id if user_id is
    // ever absent.
    const instagramId = userInfo.user_id ?? userInfo.id;
    const connection = await canConnectInstagramAccount({
      workspaceId: state.workspaceId,
      instagramId,
    });

    if (!connection.allowed) {
      return NextResponse.redirect(
        `${baseUrl}/connections?instagram=already_connected`
      );
    }

    const encryptedToken = encryptToken(longLivedToken);
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    let webhookSubscribed = false;
    try {
      const subscription = await subscribeInstagramAccountToWebhooks(
        instagramId,
        longLivedToken
      );
      webhookSubscribed = Boolean(subscription.success);
    } catch (subscriptionError) {
      console.warn(
        "[Instagram Callback] Webhook subscription failed:",
        subscriptionError
      );
    }

    await prisma.instagramAccount.upsert({
      where: { instagramId },
      create: {
        workspaceId: state.workspaceId,
        instagramId,
        username: userInfo.username,
        name: userInfo.name,
        accessToken: encryptedToken,
        tokenExpiresAt,
        webhookSubscribed,
      },
      update: {
        workspaceId: state.workspaceId,
        username: userInfo.username,
        name: userInfo.name,
        accessToken: encryptedToken,
        tokenExpiresAt,
        webhookSubscribed,
      },
    });

    if (canPublish) {
      // The scheduler reads ConnectedAccount, not InstagramAccount — it is the
      // platform-agnostic table shared with YouTube, TikTok and Facebook Pages,
      // and Instagram must not become a special case inside it. So the same
      // authorization writes a second row here rather than the two features
      // sharing one.
      //
      // Deliberately non-fatal: comment→DM is the primary feature and is
      // already committed above. A failure to light up publishing must not
      // undo it.
      try {
        const publishingData = {
          displayName: userInfo.username,
          avatarUrl: userInfo.profile_picture_url ?? null,
          // Same cipher and key as InstagramAccount.accessToken
          // (lib/crypto/token-cipher.ts), so the value is interchangeable.
          accessToken: encryptedToken,
          tokenExpiresAt,
          // ConnectedAccount.scopes documents what the platform actually
          // granted, so prefer Instagram's own list and fall back to what we
          // asked for only when it does not report one.
          scopes: permissions ?? getInstagramConnectScopes(true),
          metadata: {},
          // Reconnecting is how a user clears NEEDS_REAUTH.
          status: "ACTIVE" as const,
        };

        await prisma.connectedAccount.upsert({
          where: {
            workspaceId_platform_platformAccountId: {
              workspaceId: state.workspaceId,
              platform: "INSTAGRAM",
              platformAccountId: instagramId,
            },
          },
          create: {
            workspaceId: state.workspaceId,
            platform: "INSTAGRAM",
            platformAccountId: instagramId,
            ...publishingData,
          },
          update: publishingData,
        });
      } catch (publishingError) {
        console.error(
          "[Instagram Callback] Publishing connection failed:",
          publishingError
        );
        await prisma.operationalEvent
          .create({
            data: {
              workspaceId: state.workspaceId,
              source: "SYSTEM",
              level: "WARNING",
              message: `Connected @${userInfo.username} for DMs, but linking it for scheduled publishing failed`,
              payload: { instagramId, username: userInfo.username },
            },
          })
          .catch(() => {});
      }
    }

    return NextResponse.redirect(`${baseUrl}/connections?instagram=connected`);
  } catch (err) {
    console.error("[Instagram Callback] Error:", err);
    return NextResponse.redirect(`${baseUrl}/connections?instagram=failed`);
  }
}
