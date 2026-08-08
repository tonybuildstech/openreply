import { describe, expect, it } from "vitest";
import { parseRange } from "../lib/storage/serve";

/**
 * Range parsing, shared by the signed-URL route and the session-gated preview.
 *
 * Two very different consumers depend on it being exact. Meta's fetcher probes
 * with HEAD and then pulls large files in ranges — a wrong 206 stalls the
 * download and the Instagram container lands in ERROR with no useful reason. A
 * `<video>` scrubbing a preview needs the same thing. Silently wrong bytes are
 * the worst outcome available here, which is why anything unparseable becomes a
 * 416 rather than a guess.
 */
describe("parseRange", () => {
  const SIZE = 1000;

  it("returns null when the client asked for the whole file", () => {
    expect(parseRange(null, SIZE)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRange("bytes=0-499", SIZE)).toEqual({ start: 0, end: 499 });
    expect(parseRange("bytes=500-999", SIZE)).toEqual({ start: 500, end: 999 });
  });

  it("parses an open-ended range as everything from the offset", () => {
    expect(parseRange("bytes=500-", SIZE)).toEqual({ start: 500, end: 999 });
  });

  it("parses a suffix range as the last N bytes", () => {
    expect(parseRange("bytes=-200", SIZE)).toEqual({ start: 800, end: 999 });
  });

  it("clamps an end past the file rather than promising bytes it lacks", () => {
    expect(parseRange("bytes=900-5000", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("clamps a suffix longer than the file to the whole file", () => {
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseRange("  bytes=0-99  ", SIZE)).toEqual({ start: 0, end: 99 });
  });

  it("refuses a start at or past the end of the file", () => {
    expect(parseRange("bytes=1000-", SIZE)).toBe("unsatisfiable");
    expect(parseRange("bytes=1500-1600", SIZE)).toBe("unsatisfiable");
  });

  it("refuses an inverted range", () => {
    expect(parseRange("bytes=600-500", SIZE)).toBe("unsatisfiable");
  });

  it("refuses a zero-length suffix", () => {
    expect(parseRange("bytes=-0", SIZE)).toBe("unsatisfiable");
  });

  it("refuses multi-range requests, which we do not serve", () => {
    // Answering the first range of a multi-range request would be silently
    // wrong bytes — a 416 tells the client to ask again properly.
    expect(parseRange("bytes=0-99,200-299", SIZE)).toBe("unsatisfiable");
  });

  it("refuses anything that is not a byte range", () => {
    for (const header of ["bytes=", "bytes=abc-def", "items=0-10", "0-99"]) {
      expect(parseRange(header, SIZE)).toBe("unsatisfiable");
    }
  });
});

/**
 * The preview route's authorisation check, which is a prefix match on the
 * storage key. Keys are `{workspaceId}/{yyyy}/{mm}/{uuid}{ext}`, so the prefix
 * IS the owner — and a sloppy match here would let any signed-in user read any
 * other workspace's media by guessing a key.
 */
describe("preview workspace ownership check", () => {
  // Mirrors the check in app/api/media/preview/[...segments]/route.ts.
  const owns = (workspaceId: string, key: string) =>
    key.startsWith(`${workspaceId}/`);

  it("allows a workspace its own media", () => {
    expect(owns("ws1", "ws1/2026/08/abc.jpg")).toBe(true);
  });

  it("refuses another workspace's media", () => {
    expect(owns("ws1", "ws2/2026/08/abc.jpg")).toBe(false);
  });

  it("refuses a workspace whose id merely starts the same way", () => {
    // The trailing slash is what makes this work. Without it "ws1" would be
    // granted "ws10/…", which is a real workspace belonging to someone else.
    expect(owns("ws1", "ws10/2026/08/abc.jpg")).toBe(false);
    expect(owns("ws1", "ws1extra/2026/08/abc.jpg")).toBe(false);
  });

  it("refuses a bare id with no path after it", () => {
    expect(owns("ws1", "ws1")).toBe(false);
  });

  it("refuses a key that only mentions the workspace later", () => {
    expect(owns("ws1", "ws2/ws1/abc.jpg")).toBe(false);
  });
});
