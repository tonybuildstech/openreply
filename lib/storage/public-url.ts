/**
 * Short-lived, signed public URLs for stored media.
 *
 * Instagram's Reels container is created from a `video_url` that *Meta's*
 * servers fetch (the documented `upload_type=resumable` binary path is silently
 * ignored on `graph.instagram.com` — see the note at the top of
 * `lib/scheduler/adapters/instagram.ts`). So the file has to be reachable from
 * the public internet for the length of one publish.
 *
 * Meta's fetcher cannot authenticate, so the URL itself is the credential: an
 * HMAC over the storage key and an expiry. Unguessable, unforgeable without the
 * server secret, and dead within `DEFAULT_TTL_MS`.
 *
 * The storage key never appears in the URL in readable form — it embeds a
 * workspace ID, and these URLs end up in Meta's request logs.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { getBaseUrl, getEncryptionKeyHex } from "@/lib/env";

/**
 * Two hours. Meta downloads the file during container processing, which starts
 * seconds after creation — this is slack for a slow transfer and a retry, not a
 * window anyone should be able to sit on.
 */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

interface MediaUrlPayload {
  /** Storage key. */
  k: string;
  /** Expiry, epoch ms. */
  e: number;
}

/**
 * Derived rather than used directly: ENCRYPTION_KEY's job is AES-GCM in
 * `lib/crypto/token-cipher.ts`, and a labelled sub-key keeps the two uses from
 * ever sharing key material.
 */
function signingKey(): Buffer {
  return createHmac("sha256", Buffer.from(getEncryptionKeyHex(), "hex"))
    .update("media-public-url-v1")
    .digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

/** Meta's fetcher is happier with a plausible filename than an opaque blob. */
function filenameFor(key: string): string {
  const ext = path.extname(key).toLowerCase();
  return /^\.[a-z0-9]{2,5}$/.test(ext) ? `media${ext}` : "media";
}

/**
 * An absolute, publicly fetchable URL for a stored object.
 *
 * Throws when the deployment has no public base URL, because the alternative is
 * handing Meta a `localhost` link and reading back an opaque download failure
 * ten minutes later.
 */
export function buildSignedMediaUrl(
  key: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): string {
  const base = getBaseUrl();
  const { hostname, protocol } = new URL(base);

  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  ) {
    throw new Error(
      `NEXTAUTH_URL is ${base}. Instagram fetches the video from this app, so it must be a public HTTPS URL — a tunnel or the deployed domain.`
    );
  }
  if (protocol !== "https:") {
    throw new Error(
      `NEXTAUTH_URL is ${base}. Instagram only fetches media over HTTPS.`
    );
  }

  const payload: MediaUrlPayload = { k: key, e: now + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const token = `${encoded}.${sign(encoded)}`;

  return `${base.replace(/\/$/, "")}/api/media/public/${token}/${filenameFor(key)}`;
}

export type VerifyResult =
  | { ok: true; key: string }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

/** The inverse of `buildSignedMediaUrl`, for the route that serves the bytes. */
export function verifySignedMediaToken(
  token: string,
  now: number = Date.now()
): VerifyResult {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return { ok: false, reason: "malformed" };

  const encoded = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const expected = sign(encoded);

  const providedBytes = Buffer.from(provided, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");

  // Length check first — timingSafeEqual throws on a mismatch, and the length
  // of an HMAC is not a secret.
  if (
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: MediaUrlPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as MediaUrlPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof payload.k !== "string" || !payload.k) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.e !== "number" || payload.e <= now) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, key: payload.k };
}
