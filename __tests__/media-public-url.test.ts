import { describe, expect, it, vi, beforeEach } from "vitest";

const KEY_HEX = "a".repeat(64);
const STORAGE_KEY = "ws-abc/2026/08/3a045de8-d58e-4c0e-95a7-5244fe2484ad.mp4";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ENCRYPTION_KEY", KEY_HEX);
  vi.stubEnv("NEXTAUTH_URL", "https://openreply.example.dev");
});

async function loadSigner() {
  return import("../lib/storage/public-url");
}

function tokenFrom(url: string): string {
  // .../api/media/public/<token>/<filename>
  return new URL(url).pathname.split("/").slice(-2)[0];
}

describe("signed media URLs", () => {
  it("round-trips the storage key", async () => {
    const { buildSignedMediaUrl, verifySignedMediaToken } = await loadSigner();

    const url = buildSignedMediaUrl(STORAGE_KEY);
    expect(url.startsWith("https://openreply.example.dev/api/media/public/")).toBe(true);

    const result = verifySignedMediaToken(tokenFrom(url));
    expect(result).toEqual({ ok: true, key: STORAGE_KEY });
  });

  it("keeps the workspace id out of the URL", async () => {
    const { buildSignedMediaUrl } = await loadSigner();

    // These URLs land in Meta's logs; the raw key names a workspace.
    expect(buildSignedMediaUrl(STORAGE_KEY)).not.toContain("ws-abc");
  });

  it("preserves the file extension so Meta's fetcher sees a video", async () => {
    const { buildSignedMediaUrl } = await loadSigner();

    expect(buildSignedMediaUrl(STORAGE_KEY).endsWith("/media.mp4")).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const { buildSignedMediaUrl, verifySignedMediaToken } = await loadSigner();

    const token = tokenFrom(buildSignedMediaUrl(STORAGE_KEY));
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ k: "../../etc/passwd", e: Date.now() + 60_000 }),
      "utf8"
    ).toString("base64url");

    expect(verifySignedMediaToken(`${forged}.${signature}`)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(verifySignedMediaToken(`${payload}.${signature}x`).ok).toBe(false);
  });

  it("rejects a token signed with a different server key", async () => {
    const { buildSignedMediaUrl } = await loadSigner();
    const token = tokenFrom(buildSignedMediaUrl(STORAGE_KEY));

    vi.resetModules();
    vi.stubEnv("ENCRYPTION_KEY", "b".repeat(64));
    const { verifySignedMediaToken } = await loadSigner();

    expect(verifySignedMediaToken(token)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("expires", async () => {
    const { buildSignedMediaUrl, verifySignedMediaToken } = await loadSigner();

    const now = 1_800_000_000_000;
    const token = tokenFrom(buildSignedMediaUrl(STORAGE_KEY, 60_000, now));

    expect(verifySignedMediaToken(token, now + 59_000).ok).toBe(true);
    expect(verifySignedMediaToken(token, now + 61_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects malformed tokens without throwing", async () => {
    const { verifySignedMediaToken } = await loadSigner();

    for (const bad of ["", ".", "nodot", "..", "!!!.???"]) {
      expect(verifySignedMediaToken(bad).ok).toBe(false);
    }
  });

  it("refuses to hand Instagram a localhost or plain-http URL", async () => {
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    let signer = await loadSigner();
    expect(() => signer.buildSignedMediaUrl(STORAGE_KEY)).toThrow(/public HTTPS/);

    vi.resetModules();
    vi.stubEnv("NEXTAUTH_URL", "http://openreply.example.dev");
    signer = await loadSigner();
    expect(() => signer.buildSignedMediaUrl(STORAGE_KEY)).toThrow(/HTTPS/);
  });
});
