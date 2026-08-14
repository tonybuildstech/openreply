/**
 * The TikTok Direct Post flag.
 *
 * This is a two-sided trap, which is why it is pinned:
 *
 *  - Read as ON when TikTok has NOT approved `video.publish`, and every
 *    authorize call carries an unapproved scope — TikTok rejects those, so
 *    connecting a TikTok account breaks entirely.
 *  - Read as OFF when it was meant to be on, and posts silently keep going to
 *    the creator's inbox as drafts with no error anywhere.
 *
 * Neither side announces itself, so the parsing is worth a test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { isTikTokDirectPostEnabled } from "@/lib/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isTikTokDirectPostEnabled", () => {
  it("is off when unset — approval is opt-in, never assumed", () => {
    vi.stubEnv("TIKTOK_ENABLE_DIRECT_POST", undefined);
    expect(isTikTokDirectPostEnabled()).toBe(false);
  });

  it.each(["", "   "])("is off for blank value %j", (value) => {
    vi.stubEnv("TIKTOK_ENABLE_DIRECT_POST", value);
    expect(isTikTokDirectPostEnabled()).toBe(false);
  });

  it.each(["true", "TRUE", "True", " true ", "1", "yes", "on"])(
    "accepts %j — a self-hoster gets no feedback if their spelling is ignored",
    (value) => {
      vi.stubEnv("TIKTOK_ENABLE_DIRECT_POST", value);
      expect(isTikTokDirectPostEnabled()).toBe(true);
    }
  );

  it.each(["false", "0", "no", "off", "maybe", "video.publish"])(
    "rejects %j rather than treating any non-empty string as on",
    (value) => {
      vi.stubEnv("TIKTOK_ENABLE_DIRECT_POST", value);
      expect(isTikTokDirectPostEnabled()).toBe(false);
    }
  );
});
