import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let storageRoot: string;

beforeEach(() => {
  storageRoot = mkdtempSync(path.join(tmpdir(), "openreply-media-"));
  vi.stubEnv("MEDIA_STORAGE_DIR", storageRoot);
  vi.resetModules();
});

afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

async function loadStorage() {
  const { localMediaStorage } = await import("../lib/storage/local-driver");
  return localMediaStorage;
}

describe("local media storage", () => {
  it("round-trips a file and reports its real size", async () => {
    const storage = await loadStorage();
    const body = Buffer.from("fake video bytes");

    const meta = await storage.put("ws1/2026/08/clip.mp4", Readable.from(body), {
      contentType: "video/mp4",
    });

    expect(meta.size).toBe(body.length);
    expect(meta.contentType).toBe("video/mp4");

    const stat = await storage.stat("ws1/2026/08/clip.mp4");
    expect(stat.size).toBe(body.length);
    expect(stat.contentType).toBe("video/mp4");
  });

  /**
   * Ranged reads are what let the worker upload a gigabyte file to TikTok and
   * YouTube under a 250 MB memory cap. If this breaks, chunked uploads silently
   * start sending wrong bytes.
   */
  it("reads an exact byte range", async () => {
    const storage = await loadStorage();
    await storage.put("ws1/range.mp4", Readable.from(Buffer.from("0123456789")), {
      contentType: "video/mp4",
    });

    const chunks: Buffer[] = [];
    for await (const chunk of storage.createReadStream("ws1/range.mp4", {
      start: 2,
      end: 5,
    })) {
      chunks.push(chunk as Buffer);
    }

    // end is inclusive, matching HTTP Range and TikTok's Content-Range.
    expect(Buffer.concat(chunks).toString()).toBe("2345");
  });

  it("reassembles a file from sequential ranges without gaps or overlap", async () => {
    const storage = await loadStorage();
    const body = Buffer.from("abcdefghijklmnopqrstuvwxyz");
    await storage.put("ws1/chunked.mp4", Readable.from(body), {
      contentType: "video/mp4",
    });

    const chunkSize = 7;
    const parts: Buffer[] = [];
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, body.length) - 1;
      const chunks: Buffer[] = [];
      for await (const chunk of storage.createReadStream("ws1/chunked.mp4", {
        start: offset,
        end,
      })) {
        chunks.push(chunk as Buffer);
      }
      parts.push(Buffer.concat(chunks));
    }

    expect(Buffer.concat(parts).toString()).toBe(body.toString());
  });

  it("rejects keys that escape the storage root", async () => {
    const storage = await loadStorage();

    await expect(storage.stat("../../etc/passwd")).rejects.toThrow(
      /escapes the storage root/
    );
    expect(() => storage.createReadStream("../outside.mp4")).toThrow(
      /escapes the storage root/
    );
    await expect(storage.delete("../../boom")).rejects.toThrow(
      /escapes the storage root/
    );
  });

  it("rejects an empty key", async () => {
    const storage = await loadStorage();
    await expect(storage.stat("")).rejects.toThrow(/invalid media key/i);
  });

  it("reports a missing file as NOT_FOUND rather than a raw fs error", async () => {
    const storage = await loadStorage();
    await expect(storage.stat("ws1/missing.mp4")).rejects.toThrow(
      /Media not found/
    );
  });

  it("deletes a file and its metadata sidecar", async () => {
    const storage = await loadStorage();
    await storage.put("ws1/gone.mp4", Readable.from(Buffer.from("x")), {
      contentType: "video/mp4",
    });

    await storage.delete("ws1/gone.mp4");

    await expect(storage.stat("ws1/gone.mp4")).rejects.toThrow(/not found/i);
  });
});

describe("media keys", () => {
  it("shards by workspace and month, and keeps the right extension", async () => {
    const { buildMediaKey } = await import("../lib/storage");
    const key = buildMediaKey("ws_abc", "video/mp4");

    expect(key.startsWith("ws_abc/")).toBe(true);
    expect(key.endsWith(".mp4")).toBe(true);
    expect(key.split("/")).toHaveLength(4);
  });

  it("gives every upload a unique key so two files never collide", async () => {
    const { buildMediaKey } = await import("../lib/storage");

    expect(buildMediaKey("ws", "video/mp4")).not.toBe(
      buildMediaKey("ws", "video/mp4")
    );
  });
});
