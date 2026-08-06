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

/**
 * Regression cover for a silent corruption bug: the upload route counted bytes
 * with a `data` listener on the request body, which drained whatever had
 * already arrived before `put()` finished its mkdir and started piping. Files
 * reached disk missing their head — an MP4 with no `ftyp` box — and nothing
 * failed until YouTube rejected the video during transcode.
 *
 * These tests feed a body whose first chunks are ALREADY buffered, which is the
 * normal case in production: the handler awaits an auth/workspace lookup while
 * the client keeps uploading.
 */
describe("upload byte cap", () => {
  /** A body where the first `readyChunks` resolve instantly, the rest trickle. */
  function bufferedBody(payload: Buffer, readyChunks: number, chunkSize = 4096) {
    let offset = 0;
    let pulls = 0;

    return new ReadableStream({
      async pull(controller) {
        if (offset >= payload.length) {
          controller.close();
          return;
        }
        if (pulls++ >= readyChunks) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const size = Math.min(chunkSize, payload.length - offset);
        controller.enqueue(new Uint8Array(payload.subarray(offset, offset + size)));
        offset += size;
      },
    });
  }

  /** A minimal MP4 head — the part that used to get eaten. */
  function fakeMp4(totalBytes: number): Buffer {
    const buffer = Buffer.alloc(totalBytes);
    buffer.writeUInt32BE(0x20, 0);
    buffer.write("ftypisom", 4, "ascii");
    for (let i = 12; i < totalBytes; i++) buffer[i] = i & 0xff;
    return buffer;
  }

  it.each([0, 8, 32])(
    "stores every byte when %i chunks are already buffered",
    async (readyChunks) => {
      const storage = await loadStorage();
      const { capUploadBytes } = await import("../lib/storage/byte-cap");
      const payload = fakeMp4(256 * 1024);

      const source = Readable.fromWeb(
        bufferedBody(payload, readyChunks) as never
      );
      const meta = await storage.put(
        "ws1/buffered.mp4",
        capUploadBytes(source, 10 * 1024 * 1024),
        { contentType: "video/mp4" }
      );

      expect(meta.size).toBe(payload.length);

      const chunks: Buffer[] = [];
      for await (const chunk of storage.createReadStream("ws1/buffered.mp4")) {
        chunks.push(chunk as Buffer);
      }
      const stored = Buffer.concat(chunks);

      // Byte-for-byte, and the container header specifically.
      expect(stored.equals(payload)).toBe(true);
      expect(stored.subarray(4, 8).toString("ascii")).toBe("ftyp");
    }
  );

  it("still rejects a body that exceeds the cap", async () => {
    const storage = await loadStorage();
    const { capUploadBytes, UPLOAD_TOO_LARGE } = await import(
      "../lib/storage/byte-cap"
    );

    const source = Readable.fromWeb(bufferedBody(fakeMp4(64 * 1024), 4) as never);

    await expect(
      storage.put("ws1/toobig.mp4", capUploadBytes(source, 8 * 1024), {
        contentType: "video/mp4",
      })
    ).rejects.toThrow(UPLOAD_TOO_LARGE);
  });

  it("surfaces a request body that fails mid-flight instead of hanging", async () => {
    const storage = await loadStorage();
    const { capUploadBytes } = await import("../lib/storage/byte-cap");

    const source = new Readable({
      read() {
        this.destroy(new Error("client disconnected"));
      },
    });

    await expect(
      storage.put("ws1/aborted.mp4", capUploadBytes(source, 1024 * 1024), {
        contentType: "video/mp4",
      })
    ).rejects.toThrow(/client disconnected/);
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
