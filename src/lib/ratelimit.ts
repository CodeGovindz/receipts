/**
 * Best-effort per-IP rate limit for the public web app (plan §10): a sliding
 * one-hour window kept in memory. On Vercel each function instance has its
 * own memory, so this bounds the AWS bill per instance, not globally — the
 * README documents the limitation (Upstash is the post-hackathon upgrade).
 */

export const RATE_LIMIT_RUNS = 10;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSec: number };

const hits = new Map<string, number[]>();

/** Records one run for `key` if it is under the limit. */
export function takeRun(key: string, now: number = Date.now()): RateLimitResult {
  const recent = (hits.get(key) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_RUNS) {
    hits.set(key, recent);
    const retryAfterMs = recent[0] + RATE_LIMIT_WINDOW_MS - now;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  recent.push(now);
  hits.set(key, recent);
  return { ok: true, remaining: RATE_LIMIT_RUNS - recent.length };
}

/** Client IP from the proxy headers Vercel sets; "unknown" when absent. */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** Test support: forgets every recorded run. */
export function clearRateLimit(): void {
  hits.clear();
}
