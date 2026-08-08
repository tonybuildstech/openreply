import { createHmac, timingSafeEqual } from "crypto";
import { requireEnv } from "@/lib/env";

// The cipher moved to lib/crypto/token-cipher.ts when the scheduler needed the
// same AES-256-GCM helpers for YouTube/TikTok/Facebook tokens. Re-exported here
// so every existing caller and test keeps importing it from this module.
export { encryptToken, decryptToken } from "@/lib/crypto/token-cipher";

const INSTAGRAM_OAUTH_URL = "https://api.instagram.com/oauth/authorize";
const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface OAuthStatePayload {
  workspaceId: string;
  ts: number;
  // Whether this authorization asked for the publishing scope. Carried through
  // the signed state so the callback knows what to expect without trusting a
  // query param it did not sign. Absent on states minted before the unified
  // flow existed (and on messaging-only connects), which read as `false`.
  pub?: boolean;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signState(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(payload)
    .digest("base64url");
}

export function createOAuthState(
  workspaceId: string,
  requestedPublishing = false
): string {
  const payload = base64UrlEncode(
    JSON.stringify({
      workspaceId,
      ts: Date.now(),
      ...(requestedPublishing ? { pub: true } : {}),
    } satisfies OAuthStatePayload)
  );
  return `${payload}.${signState(payload)}`;
}

export function verifyOAuthState(state: string | null): OAuthStatePayload | null {
  if (!state) return null;

  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = signState(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as OAuthStatePayload;
    if (!parsed.workspaceId || Date.now() - parsed.ts > STATE_MAX_AGE_MS) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** What comment→DM needs: read the account, read comments, send messages. */
export const INSTAGRAM_MESSAGING_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
] as const;

/**
 * What the scheduler needs on top, to publish media. A SEPARATE App Review
 * submission from the messaging scopes — see `isUnifiedInstagramConnectEnabled()`
 * in lib/env.ts for why that matters to whoever is consenting.
 */
export const INSTAGRAM_PUBLISHING_SCOPE = "instagram_business_content_publish";

export function getInstagramConnectScopes(includePublishing: boolean): string[] {
  return includePublishing
    ? [...INSTAGRAM_MESSAGING_SCOPES, INSTAGRAM_PUBLISHING_SCOPE]
    : [...INSTAGRAM_MESSAGING_SCOPES];
}

export function getAuthorizationUrl(
  redirectUri: string,
  state: string,
  // Defaults to messaging-only so every pre-existing caller behaves exactly as
  // it did before the unified flow was added.
  scopes: readonly string[] = INSTAGRAM_MESSAGING_SCOPES
): string {
  const params = new URLSearchParams({
    client_id: requireEnv("INSTAGRAM_APP_ID"),
    redirect_uri: redirectUri,
    scope: scopes.join(","),
    response_type: "code",
    state,
  });

  return `${INSTAGRAM_OAUTH_URL}?${params.toString()}`;
}

/**
 * Whether a token may publish, given what we asked for and what Instagram said
 * it granted.
 *
 * `reported` is whatever the token exchange returned, which may be nothing:
 * it is not confirmed that Instagram-Login token responses carry a
 * `permissions` field at all (open question in
 * `.dev/changes/unified-instagram-connect/questions.md`). When it is absent we
 * trust the request — which is exactly what the scheduler's own connect flow
 * already does by hardcoding `scopes: INSTAGRAM_PUBLISH_SCOPES`. So this is
 * never worse than the status quo, and strictly better the moment Instagram
 * does report grants.
 */
export function grantedPublishing(
  requestedPublishing: boolean,
  reported?: string[] | null
): boolean {
  if (!requestedPublishing) return false;
  if (!reported || reported.length === 0) return true;
  return reported.includes(INSTAGRAM_PUBLISHING_SCOPE);
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{
  accessToken: string;
  userId: string;
  permissions?: string[];
}> {
  const body = new URLSearchParams({
    client_id: requireEnv("INSTAGRAM_APP_ID"),
    client_secret: requireEnv("INSTAGRAM_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetch(INSTAGRAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Token exchange failed: ${error.error_message || JSON.stringify(error)}`
    );
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    userId: String(data.user_id),
    // Passed through only if Instagram sends it; see `grantedPublishing()`.
    // Tolerates both an array and a comma-separated string, since the shape is
    // unconfirmed for Instagram Login tokens.
    permissions: normalizePermissions(data.permissions),
  };
}

function normalizePermissions(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim() !== "") {
    return value.split(",").map((entry) => entry.trim());
  }
  return undefined;
}

