/**
 * Access-token resolution for connected accounts.
 *
 * Every adapter calls `resolveAccessToken()` instead of reading
 * `account.accessToken` directly, because three of the four platforms need a
 * refresh at some point and each fails differently:
 *
 *  - **YouTube**  ~1 h access tokens. Refreshed on demand before every call.
 *    `invalid_grant` means the refresh token is dead — which happens *every 7
 *    days* while the Google consent screen is still in "Testing", so this is a
 *    routine state to handle, not an exotic one.
 *  - **TikTok**   ~24 h access tokens, ~365 day refresh tokens. The docs do not
 *    say whether the refresh token rotates, so we persist whatever comes back.
 *  - **Instagram** 60-day long-lived tokens, refreshed by the existing
 *    `/api/cron/refresh-tokens` job. Used as-is here.
 *  - **Facebook** Page tokens do not expire while the user token is valid.
 *
 * The naming convention from lib/crypto/token-cipher.ts applies: every
 * decrypted value is a `*PlaintextToken`, and none of them may be logged.
 */

import type { ConnectedAccount } from "@/app/generated/prisma/client";
import { encryptToken, decryptToken } from "@/lib/crypto/token-cipher";
import { prisma } from "@/lib/db/client";
import { requireEnv } from "@/lib/env";
import { PublishError } from "@/lib/scheduler/types";
import { fetchWithTimeout, toResponseSnippet } from "@/lib/scheduler/http";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

// Refresh a little before the platform's stated expiry — a token that dies
// mid-upload wastes the whole transfer.
const EXPIRY_SKEW_MS = 5 * 60_000;

async function markNeedsReauth(accountId: string): Promise<void> {
  await prisma.connectedAccount.update({
    where: { id: accountId },
    data: { status: "NEEDS_REAUTH" },
  });
}

function isExpired(account: ConnectedAccount): boolean {
  if (!account.tokenExpiresAt) return false;
  return account.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now();
}

async function refreshGoogleToken(
  account: ConnectedAccount
): Promise<string> {
  if (!account.refreshToken) {
    await markNeedsReauth(account.id);
    throw new PublishError(
      "This YouTube channel has no refresh token — reconnect it",
      false,
      { needsReauth: true }
    );
  }

  const refreshPlaintextToken = decryptToken(account.refreshToken);
  const response = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: refreshPlaintextToken,
      grant_type: "refresh_token",
    }).toString(),
    timeoutMs: 20_000,
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
  };

  if (!response.ok || !body.access_token) {
    // invalid_grant is the documented signal for a revoked or expired refresh
    // token. It is NOT transient: retrying burns attempts and never succeeds.
    // In "Testing" publishing status this fires on a 7-day cycle.
    if (body.error === "invalid_grant") {
      await markNeedsReauth(account.id);
      throw new PublishError(
        "YouTube access expired — reconnect this channel. (Google expires refresh tokens every 7 days while the OAuth consent screen is in Testing.)",
        false,
        { needsReauth: true, responseSnippet: toResponseSnippet(body) }
      );
    }

    throw new PublishError(
      `YouTube token refresh failed: ${body.error ?? response.status}`,
      response.status >= 500,
      { responseSnippet: toResponseSnippet(body) }
    );
  }

  const accessPlaintextToken = body.access_token;
  await prisma.connectedAccount.update({
    where: { id: account.id },
    data: {
      accessToken: encryptToken(accessPlaintextToken),
      tokenExpiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
      // Google usually omits refresh_token on refresh; persist it when present.
      ...(body.refresh_token
        ? { refreshToken: encryptToken(body.refresh_token) }
        : {}),
      status: "ACTIVE",
    },
  });

  return accessPlaintextToken;
}

async function refreshTikTokToken(
  account: ConnectedAccount
): Promise<string> {
  if (!account.refreshToken) {
    await markNeedsReauth(account.id);
    throw new PublishError(
      "This TikTok account has no refresh token — reconnect it",
      false,
      { needsReauth: true }
    );
  }

  const refreshPlaintextToken = decryptToken(account.refreshToken);
  const response = await fetchWithTimeout(TIKTOK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: requireEnv("TIKTOK_CLIENT_KEY"),
      client_secret: requireEnv("TIKTOK_CLIENT_SECRET"),
      refresh_token: refreshPlaintextToken,
      grant_type: "refresh_token",
    }).toString(),
    timeoutMs: 20_000,
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    const dead =
      body.error === "invalid_grant" ||
      body.error === "invalid_request" ||
      response.status === 401;

    if (dead) {
      await markNeedsReauth(account.id);
      throw new PublishError(
        "TikTok access expired — reconnect this account",
        false,
        { needsReauth: true, responseSnippet: toResponseSnippet(body) }
      );
    }

    throw new PublishError(
      `TikTok token refresh failed: ${body.error ?? response.status}`,
      response.status >= 500,
      { responseSnippet: toResponseSnippet(body) }
    );
  }

  const accessPlaintextToken = body.access_token;
  await prisma.connectedAccount.update({
    where: { id: account.id },
    data: {
      accessToken: encryptToken(accessPlaintextToken),
      tokenExpiresAt: new Date(Date.now() + (body.expires_in ?? 86400) * 1000),
      // Rotation behaviour is undocumented — persisting whatever comes back is
      // correct whether TikTok rotates or not.
      ...(body.refresh_token
        ? { refreshToken: encryptToken(body.refresh_token) }
        : {}),
      status: "ACTIVE",
    },
  });

  return accessPlaintextToken;
}

/**
 * The decrypted access token for an account, refreshed if the platform needs
 * it. Returns plaintext — the caller must never log it.
 */
export async function resolveAccessToken(
  account: ConnectedAccount
): Promise<string> {
  if (account.status === "DISABLED") {
    throw new PublishError("This account is disabled", false);
  }

  switch (account.platform) {
    case "YOUTUBE":
      // Google access tokens live ~1 hour, so a queued job almost always needs
      // a refresh. Cheap to do on demand; no separate cron required.
      return isExpired(account) || !account.tokenExpiresAt
        ? refreshGoogleToken(account)
        : decryptToken(account.accessToken);

    case "TIKTOK":
      return isExpired(account)
        ? refreshTikTokToken(account)
        : decryptToken(account.accessToken);

    case "INSTAGRAM":
    case "FACEBOOK_PAGE":
      // IG long-lived tokens are refreshed by /api/cron/refresh-tokens; FB Page
      // tokens do not expire on their own.
      if (isExpired(account)) {
        await markNeedsReauth(account.id);
        throw new PublishError(
          "This account's access token has expired — reconnect it",
          false,
          { needsReauth: true }
        );
      }
      return decryptToken(account.accessToken);
  }
}
