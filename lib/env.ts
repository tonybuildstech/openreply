import { z } from "zod";

const HEX_32_BYTE = /^[a-f0-9]{64}$/i;

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export function requireEnv(name: string): string {
  return readEnv(name);
}

export function getBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}

export function getEncryptionKeyHex(): string {
  const value = readEnv("ENCRYPTION_KEY");
  if (!HEX_32_BYTE.test(value)) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex string");
  }
  return value;
}

export function getMetaGraphApiVersion(): string {
  return process.env.META_GRAPH_API_VERSION ?? "v25.0";
}

/**
 * One Instagram authorization for both comment→DM and scheduler publishing.
 *
 * On by default: both flows are the same OAuth against the same app, so a
 * self-hosted instance connecting its own accounts has no reason to consent
 * twice.
 *
 * Turn it OFF (`IG_UNIFIED_CONNECT=0`) for a multi-tenant instance where
 * strangers connect. `instagram_business_content_publish` is a separate App
 * Review track, and a consent screen containing a permission that lacks
 * Advanced Access fails *entirely* for non-tester users — which would take the
 * already-approved messaging connection down with it. Split flows keep that
 * blast radius to the publishing feature alone.
 */
export function isUnifiedInstagramConnectEnabled(): boolean {
  const raw = process.env.IG_UNIFIED_CONNECT?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "no", "off"].includes(raw);
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

/**
 * Where original media files live. MUST resolve outside the deploy directory:
 * `.github/workflows/deploy.yml` rsyncs with `--delete` and excludes only
 * `.env`, so anything under the app root is wiped by the next deploy — after
 * the posts referencing it were already scheduled.
 */
export function getMediaStorageDir(): string {
  return process.env.MEDIA_STORAGE_DIR ?? "/var/lib/openreply/media";
}

/** Hard ceiling on an accepted upload. The VPS disk is shared with Postgres. */
export function getMaxUploadBytes(): number {
  const raw = Number(process.env.MEDIA_MAX_UPLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 1024 * 1024 * 1024;
}

/**
 * YouTube's default project quota is 10,000 units/day and videos.insert costs
 * 1,600, so this ceiling allows ~6 uploads/day across the WHOLE project. Raise
 * it only after Google grants a quota extension.
 * Source: developers.google.com/youtube/v3/determine_quota_cost (2026-08-09).
 */
export function getYouTubeDailyQuotaUnits(): number {
  const raw = Number(process.env.YOUTUBE_DAILY_QUOTA_UNITS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

export const serverEnvSchema = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().regex(HEX_32_BYTE),
  INSTAGRAM_APP_ID: z.string().min(1),
  INSTAGRAM_APP_SECRET: z.string().min(1),
  FACEBOOK_APP_SECRET: z.string().min(1),
  WEBHOOK_VERIFY_TOKEN: z.string().min(1),
});

export function validateCoreEnv() {
  return serverEnvSchema.parse(process.env);
}
