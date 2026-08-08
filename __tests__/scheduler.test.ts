import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  decryptToken,
  encryptToken,
  encryptOptionalToken,
} from "../lib/crypto/token-cipher";
import {
  PLATFORM_CONSTRAINTS,
  validateMediaForPlatform,
  validateScheduleWindow,
} from "../lib/scheduler/constraints";
import { scrubSecrets, toResponseSnippet } from "../lib/scheduler/http";
import { planChunks } from "../lib/scheduler/adapters/tiktok";
import {
  createConnectionState,
  verifyConnectionState,
} from "../lib/scheduler/oauth/state";
import { utcDayStart } from "../lib/scheduler/quota";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
});

describe("token cipher", () => {
  it("round-trips a token", () => {
    const encrypted = encryptToken("ya29.super-secret-google-token");
    expect(encrypted).not.toContain("ya29");
    expect(decryptToken(encrypted)).toBe("ya29.super-secret-google-token");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects tampered ciphertext rather than returning garbage", () => {
    const encrypted = encryptToken("token");
    const bytes = Buffer.from(encrypted, "base64");
    bytes[bytes.length - 1] ^= 0xff;

    expect(() => decryptToken(bytes.toString("base64"))).toThrow();
  });

  it("passes null through for absent refresh tokens", () => {
    expect(encryptOptionalToken(null)).toBeNull();
    expect(encryptOptionalToken(undefined)).toBeNull();
    expect(decryptToken(encryptOptionalToken("x")!)).toBe("x");
  });
});

describe("secret scrubbing", () => {
  it("redacts tokens from platform error bodies", () => {
    const raw =
      'Error at https://graph.instagram.com/v25.0/me?access_token=IGQVJYbGl2ZAE&fields=id';
    const scrubbed = scrubSecrets(raw);

    expect(scrubbed).not.toContain("IGQVJYbGl2ZAE");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("redacts JSON token fields and bearer headers", () => {
    const raw = JSON.stringify({
      access_token: "ya29.a0AfB_secret",
      authorization: "Bearer ya29.another_secret_value_here",
    });
    const scrubbed = scrubSecrets(raw);

    expect(scrubbed).not.toContain("a0AfB_secret");
    expect(scrubbed).not.toContain("another_secret_value_here");
  });

  it("redacts client secrets and TikTok upload tokens", () => {
    expect(scrubSecrets("client_secret=abc123xyz")).not.toContain("abc123xyz");
    expect(
      scrubSecrets("https://open-upload.tiktokapis.com/video/?upload_token=Xza123")
    ).not.toContain("Xza123");
  });

  it("redacts our own signed media URLs, which Meta echoes back on failure", () => {
    // The signature in the path is a read capability on the file — it must not
    // survive into PublishJobLog or the dashboard's error text.
    const raw = JSON.stringify({
      error: {
        message:
          "Only photo or video can be accepted as media type. video_url=https://openreply.ivanovic.dev/api/media/public/eyJrIjoiYSJ9.s1gnATur3/media.mp4",
      },
    });
    const scrubbed = scrubSecrets(raw);

    expect(scrubbed).not.toContain("s1gnATur3");
    expect(scrubbed).not.toContain("eyJrIjoiYSJ9");
    expect(scrubbed).toContain("/api/media/public/[REDACTED]");
  });

  it("truncates snippets so a huge body cannot bloat the log table", () => {
    expect(toResponseSnippet("x".repeat(5000)).length).toBeLessThanOrEqual(500);
  });
});

/**
 * The `*PlaintextToken` naming convention only earns its keep if something
 * checks it. This walks the scheduler source and fails if a decrypted token
 * variable is passed to a logger — the exact mistake that would persist a live
 * publishing credential to disk.
 */
describe("no plaintext token reaches a log", () => {
  function collectSourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return collectSourceFiles(full);
      return full.endsWith(".ts") ? [full] : [];
    });
  }

  it("never logs a *PlaintextToken variable", () => {
    const roots = [
      path.resolve(__dirname, "../lib/scheduler"),
      path.resolve(__dirname, "../lib/crypto"),
      path.resolve(__dirname, "../lib/queue"),
    ];

    const offenders: string[] = [];
    // [^)]* already spans newlines, so no dotAll flag is needed (and the `s`
    // flag would need an es2018+ target).
    const logCall = /console\.(log|warn|error|info|debug)\(([^)]*)\)/g;

    for (const root of roots) {
      for (const file of collectSourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(logCall)) {
          if (/PlaintextToken/.test(match[2])) {
            offenders.push(`${path.basename(file)}: ${match[0].slice(0, 80)}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("scheduler OAuth state", () => {
  it("round-trips workspace and platform", () => {
    const state = createConnectionState("workspace_1", "YOUTUBE");
    const parsed = verifyConnectionState(state);

    expect(parsed?.workspaceId).toBe("workspace_1");
    expect(parsed?.platform).toBe("YOUTUBE");
  });

  it("rejects a tampered signature", () => {
    const state = createConnectionState("workspace_1", "TIKTOK");
    const [payload] = state.split(".");

    expect(verifyConnectionState(`${payload}.forged`)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const state = createConnectionState("workspace_1", "TIKTOK");
    const [, signature] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        workspaceId: "workspace_2",
        platform: "TIKTOK",
        ts: Date.now(),
      })
    ).toString("base64url");

    expect(verifyConnectionState(`${forged}.${signature}`)).toBeNull();
  });

  it("rejects expired state", () => {
    vi.useFakeTimers();
    const state = createConnectionState("workspace_1", "INSTAGRAM");
    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(verifyConnectionState(state)).toBeNull();
    vi.useRealTimers();
  });
});

describe("TikTok chunk planning", () => {
  it("uploads a small file whole, since 5 MB is TikTok's chunk minimum", () => {
    const plan = planChunks(3 * 1024 * 1024);

    expect(plan.totalChunkCount).toBe(1);
    expect(plan.chunkSize).toBe(3 * 1024 * 1024);
  });

  it("uses floor(size / chunkSize), so the last chunk absorbs the remainder", () => {
    // 12 MB at a 5 MB chunk is 2 chunks, not 3 — the trailing 2 MB rides along
    // on the final chunk. TikTok rejects the arithmetic otherwise.
    const plan = planChunks(12 * 1024 * 1024);

    expect(plan.chunkSize).toBe(5 * 1024 * 1024);
    expect(plan.totalChunkCount).toBe(2);
  });

  it("stays within TikTok's 1000-chunk ceiling for huge files", () => {
    const plan = planChunks(4 * 1024 * 1024 * 1024);

    expect(plan.totalChunkCount).toBeLessThanOrEqual(1000);
    expect(plan.chunkSize).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it("never plans a zero-length chunk", () => {
    for (const size of [1, 5 * 1024 * 1024 + 1, 100 * 1024 * 1024]) {
      const plan = planChunks(size);
      expect(plan.chunkSize).toBeGreaterThan(0);
      expect(plan.totalChunkCount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("schedule window validation", () => {
  const now = new Date("2026-08-09T12:00:00Z");

  it("rejects a Facebook post inside the documented 10-minute floor", () => {
    const issue = validateScheduleWindow(
      "FACEBOOK_PAGE",
      new Date("2026-08-09T12:05:00Z"),
      now
    );

    expect(issue?.code).toBe("TOO_SOON");
  });

  it("rejects a Facebook post beyond 75 days", () => {
    const issue = validateScheduleWindow(
      "FACEBOOK_PAGE",
      new Date("2026-12-09T12:00:00Z"),
      now
    );

    expect(issue?.code).toBe("TOO_FAR");
  });

  it("requires an hour of lead time for YouTube", () => {
    expect(
      validateScheduleWindow("YOUTUBE", new Date("2026-08-09T12:30:00Z"), now)
        ?.code
    ).toBe("TOO_SOON");
    expect(
      validateScheduleWindow("YOUTUBE", new Date("2026-08-09T14:00:00Z"), now)
    ).toBeNull();
  });

  it("accepts a valid Instagram window", () => {
    expect(
      validateScheduleWindow("INSTAGRAM", new Date("2026-08-09T13:00:00Z"), now)
    ).toBeNull();
  });
});

describe("media validation", () => {
  it("rejects MOV for Instagram but accepts it for TikTok", () => {
    const media = { mimeType: "video/quicktime", sizeBytes: 10_000 };

    expect(validateMediaForPlatform("INSTAGRAM", media)).toMatch(/video\/mp4/);
    expect(validateMediaForPlatform("TIKTOK", media)).toBeNull();
  });

  it("rejects a file over the platform's size ceiling", () => {
    const issue = validateMediaForPlatform("TIKTOK", {
      mimeType: "video/mp4",
      sizeBytes: 5 * 1024 ** 3,
    });

    expect(issue).toMatch(/larger than/);
  });

  it("documents a daily cap for every platform that publishes one", () => {
    // Instagram is 50, not the 25 this asserted until 2026-08-08 — Meta's own
    // content-publishing guide documents 50 per rolling 24h, with a carousel
    // counting as one. See __tests__/instagram-quota.test.ts for the pre-flight
    // that reads the account's real number.
    expect(PLATFORM_CONSTRAINTS.INSTAGRAM.dailyPostCap).toBe(50);
    expect(PLATFORM_CONSTRAINTS.FACEBOOK_PAGE.dailyPostCap).toBe(30);
    expect(PLATFORM_CONSTRAINTS.TIKTOK.dailyPostCap).toBe(15);
  });

  it("keeps the composer's stated Instagram cap in step with the constraint", () => {
    // These two drifting apart is how the UI ends up promising a limit the
    // adapter does not enforce.
    const cap = PLATFORM_CONSTRAINTS.INSTAGRAM.dailyPostCap;
    expect(
      PLATFORM_CONSTRAINTS.INSTAGRAM.notes.some((note) =>
        note.includes(`${cap} posts per rolling 24 hours`)
      )
    ).toBe(true);
  });
});

describe("quota day bucketing", () => {
  it("normalises to UTC midnight, matching how platforms define the day", () => {
    const bucket = utcDayStart(new Date("2026-08-09T23:59:59Z"));

    expect(bucket.toISOString()).toBe("2026-08-09T00:00:00.000Z");
  });

  it("puts times either side of UTC midnight in different buckets", () => {
    const before = utcDayStart(new Date("2026-08-09T23:59:00Z"));
    const after = utcDayStart(new Date("2026-08-10T00:01:00Z"));

    expect(before.getTime()).not.toBe(after.getTime());
  });
});
