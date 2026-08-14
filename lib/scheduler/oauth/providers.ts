/**
 * OAuth provider definitions for the four publishing platforms.
 *
 * Each provider exposes an authorization URL and a `completeConnection` that
 * exchanges the code and returns everything `ConnectedAccount` needs. Token
 * encryption happens in the callback route, so nothing here returns ciphertext
 * — and nothing here logs a token.
 *
 * Scope choices trace to the research round (2026-08-06/09); see
 * `.dev/STACK.md` for the table and each platform's review requirements.
 */

import type { SocialPlatform } from "@/app/generated/prisma/client";
import {
  getBaseUrl,
  getMetaGraphApiVersion,
  isTikTokDirectPostEnabled,
  requireEnv,
} from "@/lib/env";
import { fetchWithTimeout, toResponseSnippet } from "@/lib/scheduler/http";
import { SLUG_BY_PLATFORM } from "@/lib/scheduler/oauth/state";
import type { TikTokAccountMetadata } from "@/lib/scheduler/adapters/tiktok";

export interface ResolvedAccount {
  platformAccountId: string;
  displayName: string;
  avatarUrl?: string;
  accessPlaintextToken: string;
  refreshPlaintextToken?: string;
  expiresAt?: Date;
  scopes: string[];
  metadata?: Record<string, unknown>;
}

export interface OAuthProvider {
  platform: SocialPlatform;
  /** All accounts a single authorization can yield (Facebook returns Pages). */
  authorizationUrl(state: string): string;
  completeConnection(code: string): Promise<ResolvedAccount[]>;
}

export function redirectUriFor(platform: SocialPlatform): string {
  return `${getBaseUrl()}/api/connections/${SLUG_BY_PLATFORM[platform]}/callback`;
}

async function readJson<T>(response: Response, context: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: unknown;
    error_description?: string;
  };

  if (!response.ok) {
    throw new Error(
      `${context} failed (HTTP ${response.status}): ${toResponseSnippet(body, 200)}`
    );
  }

  return body;
}

// ─── Instagram ──────────────────────────────────────────────────────────────

/**
 * Publishing needs `instagram_business_content_publish` on top of the basic
 * scope. This is a SEPARATE App Review submission from the messaging scopes the
 * comment→DM feature already uses; neither approval depends on the other, so
 * this connection is deliberately independent of that integration.
 */
const INSTAGRAM_PUBLISH_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
];

// Pin the version explicitly. An unversioned graph.instagram.com call is served
// at whatever the App Dashboard's "Upgrade API Version" setting happens to be,
// so it can change under us without a deploy — and it would disagree with
// lib/meta/client.ts, which versions these same two endpoints.
function instagramGraphBase(): string {
  return `https://graph.instagram.com/${getMetaGraphApiVersion()}`;
}

const instagramProvider: OAuthProvider = {
  platform: "INSTAGRAM",

  authorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: requireEnv("INSTAGRAM_APP_ID"),
      redirect_uri: redirectUriFor("INSTAGRAM"),
      scope: INSTAGRAM_PUBLISH_SCOPES.join(","),
      response_type: "code",
      state,
    });
    return `https://api.instagram.com/oauth/authorize?${params}`;
  },

  async completeConnection(code) {
    const tokenResponse = await fetchWithTimeout(
      "https://api.instagram.com/oauth/access_token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: requireEnv("INSTAGRAM_APP_ID"),
          client_secret: requireEnv("INSTAGRAM_APP_SECRET"),
          grant_type: "authorization_code",
          redirect_uri: redirectUriFor("INSTAGRAM"),
          code,
        }).toString(),
      }
    );

    const shortLived = await readJson<{
      access_token: string;
      user_id: number | string;
    }>(tokenResponse, "Instagram token exchange");

    // Swap for a 60-day token immediately — the short-lived one expires in an
    // hour and a scheduler holds credentials for months.
    const longLivedResponse = await fetchWithTimeout(
      `${instagramGraphBase()}/access_token?${new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: requireEnv("INSTAGRAM_APP_SECRET"),
        access_token: shortLived.access_token,
      })}`
    );
    const longLived = await readJson<{
      access_token: string;
      expires_in: number;
    }>(longLivedResponse, "Instagram long-lived token exchange");

    const profileResponse = await fetchWithTimeout(
      `${instagramGraphBase()}/me?${new URLSearchParams({
        fields: "id,user_id,username,profile_picture_url,account_type",
        access_token: longLived.access_token,
      })}`
    );
    const profile = await readJson<{
      id: string;
      user_id?: string;
      username: string;
      profile_picture_url?: string;
      account_type?: string;
    }>(profileResponse, "Instagram profile lookup");

    return [
      {
        // The professional account ID (user_id) is what the publishing
        // endpoints key off — not the app-scoped `id`.
        platformAccountId: String(profile.user_id ?? profile.id),
        displayName: profile.username,
        avatarUrl: profile.profile_picture_url,
        accessPlaintextToken: longLived.access_token,
        expiresAt: new Date(Date.now() + longLived.expires_in * 1000),
        scopes: INSTAGRAM_PUBLISH_SCOPES,
        metadata: { accountType: profile.account_type },
      },
    ];
  },
};

// ─── YouTube ────────────────────────────────────────────────────────────────

// youtube.upload alone cannot read the channel list, so readonly comes along
// for channel discovery. The broader `youtube` scope would cover both but is
// more sensitive than this feature needs.
const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

const youtubeProvider: OAuthProvider = {
  platform: "YOUTUBE",

  authorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      redirect_uri: redirectUriFor("YOUTUBE"),
      response_type: "code",
      scope: YOUTUBE_SCOPES.join(" "),
      // Both are required to reliably receive a refresh token: offline asks for
      // one, consent forces it even when the user has authorized before.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },

  async completeConnection(code) {
    const tokenResponse = await fetchWithTimeout(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: requireEnv("GOOGLE_CLIENT_ID"),
          client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
          redirect_uri: redirectUriFor("YOUTUBE"),
          grant_type: "authorization_code",
        }).toString(),
      }
    );

    const token = await readJson<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    }>(tokenResponse, "Google token exchange");

    if (!token.refresh_token) {
      // Without one, the connection dies in an hour and cannot recover. Better
      // to refuse now than to store a credential that silently stops working.
      throw new Error(
        "Google did not return a refresh token. Remove OpenReply at myaccount.google.com/permissions and connect again."
      );
    }

    const channelResponse = await fetchWithTimeout(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${token.access_token}` } }
    );
    const channels = await readJson<{
      items?: Array<{
        id: string;
        snippet?: {
          title?: string;
          thumbnails?: { default?: { url?: string } };
        };
      }>;
    }>(channelResponse, "YouTube channel lookup");

    const channel = channels.items?.[0];
    if (!channel) {
      throw new Error(
        "This Google account has no YouTube channel. Create one, then connect again."
      );
    }

    return [
      {
        platformAccountId: channel.id,
        displayName: channel.snippet?.title ?? "YouTube channel",
        avatarUrl: channel.snippet?.thumbnails?.default?.url,
        accessPlaintextToken: token.access_token,
        refreshPlaintextToken: token.refresh_token,
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        scopes: token.scope?.split(" ") ?? YOUTUBE_SCOPES,
        // Set to true by hand once the Cloud project passes YouTube's audit;
        // until then the UI warns that uploads stay private.
        metadata: { projectAudited: false },
      },
    ];
  },
};

// ─── Facebook Pages ─────────────────────────────────────────────────────────

// The documented minimum for Page video and Reels publishing. `publish_video`
// is for LIVE video and its necessity here is unconfirmed, so it is not
// requested — asking for permissions you cannot justify fails App Review.
const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
];

// Every Facebook host here must read the version from env, not hardcode it —
// otherwise bumping META_GRAPH_API_VERSION moves the whole app except this
// connect flow, and the mismatch only surfaces when a version is sunset.
function facebookGraphBase(): string {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

const facebookProvider: OAuthProvider = {
  platform: "FACEBOOK_PAGE",

  authorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: requireEnv("FACEBOOK_APP_ID"),
      redirect_uri: redirectUriFor("FACEBOOK_PAGE"),
      response_type: "code",
      scope: FACEBOOK_SCOPES.join(","),
      state,
    });
    return `https://www.facebook.com/${getMetaGraphApiVersion()}/dialog/oauth?${params}`;
  },

  async completeConnection(code) {
    const tokenResponse = await fetchWithTimeout(
      `${facebookGraphBase()}/oauth/access_token?${new URLSearchParams({
        client_id: requireEnv("FACEBOOK_APP_ID"),
        client_secret: requireEnv("FACEBOOK_APP_SECRET"),
        redirect_uri: redirectUriFor("FACEBOOK_PAGE"),
        code,
      })}`
    );
    const shortLived = await readJson<{ access_token: string }>(
      tokenResponse,
      "Facebook token exchange"
    );

    // Page tokens inherit their lifetime from the user token they came from,
    // so exchange for a long-lived user token BEFORE listing Pages.
    const longLivedResponse = await fetchWithTimeout(
      `${facebookGraphBase()}/oauth/access_token?${new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: requireEnv("FACEBOOK_APP_ID"),
        client_secret: requireEnv("FACEBOOK_APP_SECRET"),
        fb_exchange_token: shortLived.access_token,
      })}`
    );
    const longLived = await readJson<{ access_token: string }>(
      longLivedResponse,
      "Facebook long-lived token exchange"
    );

    const pagesResponse = await fetchWithTimeout(
      `${facebookGraphBase()}/me/accounts?${new URLSearchParams({
        fields: "id,name,access_token,category,tasks,picture{url}",
        access_token: longLived.access_token,
      })}`
    );
    const pages = await readJson<{
      data?: Array<{
        id: string;
        name: string;
        access_token: string;
        category?: string;
        tasks?: string[];
        picture?: { data?: { url?: string } };
      }>;
    }>(pagesResponse, "Facebook Page lookup");

    // Publishing needs the CREATE_CONTENT task. A Page the user can only
    // analyze would fail at publish time with a permissions error, so filter
    // it out at connect time instead.
    const publishable = (pages.data ?? []).filter((page) =>
      page.tasks?.includes("CREATE_CONTENT")
    );

    if (publishable.length === 0) {
      throw new Error(
        "No Facebook Pages found that you can create content on. You need a Page role that includes content creation."
      );
    }

    return publishable.map((page) => ({
      platformAccountId: page.id,
      displayName: page.name,
      avatarUrl: page.picture?.data?.url,
      // The PAGE token, not the user token — this is what publishes.
      accessPlaintextToken: page.access_token,
      // Page tokens carry no expiry while the underlying user token is valid.
      scopes: FACEBOOK_SCOPES,
      metadata: { category: page.category, tasks: page.tasks },
    }));
  },
};

// ─── TikTok ─────────────────────────────────────────────────────────────────

/**
 * `video.upload` alone covers the inbox flow, which is what every account uses
 * by default (`postMode: "INBOX"`). `video.publish` is the Direct Post scope and
 * is deliberately opt-in via env, because:
 *
 *  - TikTok rejects an authorize call containing a scope the app is not
 *    approved for, so requesting it before approval breaks connecting entirely;
 *  - their review form warns that submitting unused scopes delays the result;
 *  - and per the Content Sharing Guidelines, Direct Post approval is unlikely
 *    for a self-hosted tool in the first place (see the research findings).
 *
 * Set TIKTOK_ENABLE_DIRECT_POST=true only once TikTok has approved
 * `video.publish` for your app.
 */
function tiktokScopes(): string[] {
  const scopes = ["user.info.basic", "video.upload"];
  if (isTikTokDirectPostEnabled()) {
    scopes.push("video.publish");
  }
  return scopes;
}

const tiktokProvider: OAuthProvider = {
  platform: "TIKTOK",

  authorizationUrl(state) {
    const params = new URLSearchParams({
      client_key: requireEnv("TIKTOK_CLIENT_KEY"),
      response_type: "code",
      scope: tiktokScopes().join(","),
      redirect_uri: redirectUriFor("TIKTOK"),
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
  },

  async completeConnection(code) {
    const tokenResponse = await fetchWithTimeout(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: requireEnv("TIKTOK_CLIENT_KEY"),
          client_secret: requireEnv("TIKTOK_CLIENT_SECRET"),
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUriFor("TIKTOK"),
        }).toString(),
      }
    );

    const token = await readJson<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      open_id: string;
      scope?: string;
    }>(tokenResponse, "TikTok token exchange");

    const profileResponse = await fetchWithTimeout(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      { headers: { Authorization: `Bearer ${token.access_token}` } }
    );
    const profile = await readJson<{
      data?: { user?: { display_name?: string; avatar_url?: string } };
    }>(profileResponse, "TikTok profile lookup");

    // Both values follow the app's approval state, because the token being
    // minted right now does too: `tiktokScopes()` only asked for
    // `video.publish` under the same flag, so an account connected while the
    // app is unapproved CANNOT direct post no matter what metadata claims.
    //
    // Unapproved → inbox is the honest default, since TikTok forces every
    // Direct Post from an unaudited app to SELF_ONLY — a private video the
    // creator never asked for. Approved → Direct Post is what the user turned
    // the flag on to get, and the composer already collects TikTok's mandatory
    // choices (privacy level, interaction toggles, commercial disclosure) for
    // that path. Either way it stays switchable per account via
    // PATCH /api/scheduler/accounts.
    const directPostApproved = isTikTokDirectPostEnabled();
    const metadata: TikTokAccountMetadata = {
      postMode: directPostApproved ? "DIRECT_POST" : "INBOX",
      auditApproved: directPostApproved,
      creatorUsername: profile.data?.user?.display_name,
    };

    return [
      {
        // open_id is stable across re-auth — the correct account key.
        platformAccountId: token.open_id,
        displayName: profile.data?.user?.display_name ?? "TikTok account",
        avatarUrl: profile.data?.user?.avatar_url,
        accessPlaintextToken: token.access_token,
        refreshPlaintextToken: token.refresh_token,
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        scopes: token.scope?.split(",") ?? tiktokScopes(),
        metadata: metadata as unknown as Record<string, unknown>,
      },
    ];
  },
};

const PROVIDERS: Record<SocialPlatform, OAuthProvider> = {
  INSTAGRAM: instagramProvider,
  YOUTUBE: youtubeProvider,
  FACEBOOK_PAGE: facebookProvider,
  TIKTOK: tiktokProvider,
};

export function getOAuthProvider(platform: SocialPlatform): OAuthProvider {
  return PROVIDERS[platform];
}
