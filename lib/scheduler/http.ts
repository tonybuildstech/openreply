/**
 * Shared HTTP concerns for the publish adapters.
 *
 * The important function here is `scrubSecrets`. Platform error responses echo
 * back request context — Meta includes the failing URL, TikTok and Google
 * include request payloads — so an unscrubbed error body written to
 * PublishJobLog or shown in the dashboard would persist a live publishing
 * credential in the database. Every adapter runs its error text through this
 * before it goes anywhere.
 */

const SECRET_PATTERNS: RegExp[] = [
  // access_token=... / refresh_token=... in query strings or form bodies
  /((?:access|refresh|id)_token=)[^&\s"']+/gi,
  // "access_token": "..." in JSON
  /(("(?:access|refresh|id)_token"\s*:\s*"))[^"]+/gi,
  // Authorization: Bearer ... / OAuth ...
  /((?:authorization|bearer|oauth)\s*:?\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  // client_secret in any shape
  /((?:client_secret|client_key)["'=:\s]+)[^&\s"',}]+/gi,
  // Google access tokens are recognisable on sight
  /ya29\.[A-Za-z0-9._-]+/g,
  // TikTok upload URLs carry an upload_token
  /(upload_token=)[^&\s"']+/gi,
  // Our own signed media URLs (lib/storage/public-url.ts). The path IS the
  // credential, and Meta echoes the failing video_url straight back at us.
  /(\/api\/media\/public\/)[^\s"'<>]+/g,
];

export function scrubSecrets(input: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (_m, prefix = "") => `${prefix}[REDACTED]`),
    input
  );
}

/** Truncated, scrubbed error text safe for PublishJobLog and the dashboard. */
export function toResponseSnippet(value: unknown, maxLength = 500): string {
  const raw =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : (() => {
            try {
              return JSON.stringify(value);
            } catch {
              return String(value);
            }
          })();

  return scrubSecrets(raw).slice(0, maxLength);
}

/** `fetch` with a timeout, so a stalled upload can't pin a worker forever. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 60_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTP statuses worth retrying regardless of platform. 429 and 5xx are
 * transient by definition; 408 is a timeout. Everything else is the platform
 * telling us the request itself is wrong, and retrying it just repeats the
 * mistake.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Log Meta's rate-limit headers so we can see a throttle coming rather than
 * discovering it as a hard block. Meta only sends these once usage is
 * non-trivial, so absence is normal and not worth noting.
 */
export function logMetaUsageHeaders(context: string, response: Response): void {
  const appUsage = response.headers.get("x-app-usage");
  const bucUsage = response.headers.get("x-business-use-case-usage");
  if (appUsage || bucUsage) {
    console.log(
      `[${context}] Meta usage — app: ${appUsage ?? "n/a"} buc: ${bucUsage ?? "n/a"}`
    );
  }
}
