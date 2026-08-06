/**
 * Token cipher — AES-256-GCM at rest for every OAuth credential we hold.
 *
 * Extracted from `lib/meta/oauth.ts` (which re-exports it, so existing callers
 * are unchanged) once the scheduler needed the same cipher for YouTube, TikTok
 * and Facebook Page tokens. One key for the whole app: `ENCRYPTION_KEY`, a
 * 32-byte hex string validated in `lib/env.ts`.
 *
 * Layout of the stored value: base64( iv | authTag | ciphertext ).
 *
 * CONVENTION — every decrypted value must be named `*PlaintextToken`. That is
 * what makes the leak audit in `__tests__/token-cipher.test.ts` possible: it
 * greps the source tree for plaintext tokens reaching a log or a client-visible
 * error. A convention nobody can check is not a control.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { getEncryptionKeyHex } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  return Buffer.from(getEncryptionKeyHex(), "hex");
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);

  return combined.toString("base64");
}

export function decryptToken(encryptedBase64: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encryptedBase64, "base64");

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}

/**
 * Encrypt when a value is present, pass null through. Refresh tokens are
 * nullable (Facebook Page tokens have none) and this keeps every call site from
 * repeating the same ternary.
 */
export function encryptOptionalToken(plaintext: string | null | undefined) {
  return plaintext ? encryptToken(plaintext) : null;
}
