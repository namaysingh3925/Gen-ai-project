import { env } from "./env";
import { ApiError } from "./http";
import { kv } from "./store";

export interface RateInfo {
  limit: number;
  remaining: number;
  /** Unix seconds when the current window ends. */
  resetAt: number;
  allowed: boolean;
  retryAfter: number;
}

/** Fixed-window counter. `bucket` identifies who/what is limited. */
export async function hit(bucket: string, limit: number, windowSec: number): Promise<RateInfo> {
  const now = Math.floor(Date.now() / 1000);
  const win = Math.floor(now / windowSec);
  const n = await kv().incr(`rl:${bucket}:${win}`, windowSec + 5);
  const resetAt = (win + 1) * windowSec;
  return { limit, remaining: Math.max(0, limit - n), resetAt, allowed: n <= limit, retryAfter: Math.max(1, resetAt - now) };
}

export function applyRateHeaders(headers: Headers, info: RateInfo) {
  headers.set("X-RateLimit-Limit", String(info.limit));
  headers.set("X-RateLimit-Remaining", String(info.remaining));
  headers.set("X-RateLimit-Reset", String(info.resetAt));
}

export function rateLimitedError(info: RateInfo, what: string) {
  return new ApiError(
    429,
    "rate_limited",
    `Too many ${what}. Retry in ${info.retryAfter}s.`,
    { limit: info.limit, resetAt: info.resetAt },
    { "Retry-After": String(info.retryAfter) },
  );
}

/* ---- Daily generation quota (protects the shared Gemini free tier) ---- */

const DAY = 86400;
const dayWindow = () => Math.floor(Date.now() / 1000 / DAY);
const dayKey = (keyId: string) => `gen:${keyId}:${dayWindow()}`;

export interface QuotaInfo {
  used: number;
  limit: number;
  remaining: number;
  resetAt: number;
}

export async function generationUsage(keyId: string): Promise<QuotaInfo> {
  const used = (await kv().get<number>(dayKey(keyId))) ?? 0;
  const limit = env.generationsPerDay;
  return { used, limit, remaining: Math.max(0, limit - used), resetAt: (dayWindow() + 1) * DAY };
}

function quotaError(q: QuotaInfo) {
  return new ApiError(
    429,
    "daily_quota_exceeded",
    `Daily generation quota of ${q.limit} reached for this API key. It resets at 00:00 UTC.`,
    { limit: q.limit, resetAt: q.resetAt },
    { "Retry-After": String(Math.max(1, q.resetAt - Math.floor(Date.now() / 1000))) },
  );
}

/** Cheap pre-flight check used by routes before a job is accepted (does not consume quota). */
export async function assertQuotaAvailable(keyId: string) {
  const q = await generationUsage(keyId);
  if (q.remaining <= 0) throw quotaError(q);
}

/** Consume one generation. Called right before the first LLM call of a job. */
export async function consumeGeneration(keyId: string) {
  const used = await kv().incr(dayKey(keyId), DAY + 60);
  const q: QuotaInfo = {
    used,
    limit: env.generationsPerDay,
    remaining: Math.max(0, env.generationsPerDay - used),
    resetAt: (dayWindow() + 1) * DAY,
  };
  if (used > q.limit) throw quotaError(q);
  return q;
}
