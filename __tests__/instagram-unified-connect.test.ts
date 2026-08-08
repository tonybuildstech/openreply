import { beforeEach, describe, expect, it, vi } from "vitest";
import { isUnifiedInstagramConnectEnabled } from "../lib/env";
import {
  INSTAGRAM_MESSAGING_SCOPES,
  INSTAGRAM_PUBLISHING_SCOPE,
  createOAuthState,
  getAuthorizationUrl,
  getInstagramConnectScopes,
  grantedPublishing,
  verifyOAuthState,
} from "../lib/meta/oauth";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv("INSTAGRAM_APP_ID", "1234567890");
});

function scopesOf(url: string): string[] {
  return (new URL(url).searchParams.get("scope") ?? "").split(",");
}

describe("IG_UNIFIED_CONNECT flag", () => {
  it("defaults to on when unset or empty", () => {
    expect(isUnifiedInstagramConnectEnabled()).toBe(true);
    vi.stubEnv("IG_UNIFIED_CONNECT", "");
    expect(isUnifiedInstagramConnectEnabled()).toBe(true);
  });

  it("treats the usual falsy spellings as off", () => {
    for (const value of ["0", "false", "FALSE", "no", "off", " off "]) {
      vi.stubEnv("IG_UNIFIED_CONNECT", value);
      expect(isUnifiedInstagramConnectEnabled()).toBe(false);
    }
  });

  it("stays on for anything else", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      vi.stubEnv("IG_UNIFIED_CONNECT", value);
      expect(isUnifiedInstagramConnectEnabled()).toBe(true);
    }
  });
});

describe("connect scope sets", () => {
  it("adds only the publishing scope to the messaging set", () => {
    expect(getInstagramConnectScopes(false)).toEqual([
      ...INSTAGRAM_MESSAGING_SCOPES,
    ]);
    expect(getInstagramConnectScopes(true)).toEqual([
      ...INSTAGRAM_MESSAGING_SCOPES,
      INSTAGRAM_PUBLISHING_SCOPE,
    ]);
  });

  it("keeps every messaging scope the DM feature already relied on", () => {
    // Losing one of these silently breaks comment→DM, so pin them explicitly
    // rather than trusting the constant.
    expect(getInstagramConnectScopes(true)).toEqual(
      expect.arrayContaining([
        "instagram_business_basic",
        "instagram_business_manage_messages",
        "instagram_business_manage_comments",
        "instagram_business_manage_insights",
      ])
    );
  });

  it("defaults the authorization URL to messaging-only for existing callers", () => {
    const url = getAuthorizationUrl("https://example.com/cb", "state");
    expect(scopesOf(url)).toEqual([...INSTAGRAM_MESSAGING_SCOPES]);
    expect(scopesOf(url)).not.toContain(INSTAGRAM_PUBLISHING_SCOPE);
  });

  it("carries the unified scope set when asked", () => {
    const url = getAuthorizationUrl(
      "https://example.com/cb",
      "state",
      getInstagramConnectScopes(true)
    );
    expect(scopesOf(url)).toContain(INSTAGRAM_PUBLISHING_SCOPE);
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      "https://example.com/cb"
    );
  });
});

describe("OAuth state carries the publishing request", () => {
  it("round-trips the publishing flag", () => {
    const state = createOAuthState("workspace_123", true);
    const verified = verifyOAuthState(state);
    expect(verified?.workspaceId).toBe("workspace_123");
    expect(verified?.pub).toBe(true);
  });

  it("omits the flag for a messaging-only connect", () => {
    expect(verifyOAuthState(createOAuthState("workspace_123"))?.pub).toBeUndefined();
  });

  it("still rejects a tampered state carrying the flag", () => {
    const state = createOAuthState("workspace_123", true);
    expect(verifyOAuthState(`${state}x`)).toBeNull();
  });
});

describe("grantedPublishing", () => {
  it("is false whenever publishing was not requested", () => {
    expect(grantedPublishing(false)).toBe(false);
    expect(grantedPublishing(false, [INSTAGRAM_PUBLISHING_SCOPE])).toBe(false);
  });

  it("trusts the request when Instagram reports no permissions", () => {
    // Unconfirmed whether the token response carries `permissions` at all —
    // absent must mean "assume granted", matching the scheduler's own flow.
    expect(grantedPublishing(true)).toBe(true);
    expect(grantedPublishing(true, undefined)).toBe(true);
    expect(grantedPublishing(true, null)).toBe(true);
    expect(grantedPublishing(true, [])).toBe(true);
  });

  it("honors a reported grant list when one is present", () => {
    expect(
      grantedPublishing(true, [
        "instagram_business_basic",
        INSTAGRAM_PUBLISHING_SCOPE,
      ])
    ).toBe(true);

    expect(
      grantedPublishing(true, [
        "instagram_business_basic",
        "instagram_business_manage_messages",
      ])
    ).toBe(false);
  });
});
