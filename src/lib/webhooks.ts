/**
 * Outbound webhooks. Subscribers register an https URL + event list; RepoScribe POSTs a JSON
 * envelope whenever something happens:
 *
 *   { "id": "evt_...", "type": "doc.completed", "apiVersion": "v1", "createdAt": "...", "data": {...} }
 *
 * Every delivery is signed so receivers can verify it came from us:
 *   X-RepoScribe-Timestamp: <unix seconds>
 *   X-RepoScribe-Signature: v1=<hex hmac-sha256(secret, `${timestamp}.${rawBody}`)>
 * 2xx = success. 5xx / 429 / 408 / network errors are retried (3 attempts, backoff); other 4xx are not.
 * After 10 consecutive failed deliveries the webhook is disabled automatically.
 */
import { hmacSha256, newId, randomToken, safeEqual } from "./crypto";
import { ApiError } from "./http";
import { assertSafeWebhookUrl } from "./ssrf";
import { kv } from "./store";
import { WEBHOOK_EVENTS, type DocJob, type WebhookEvent } from "./types";

export const MAX_WEBHOOKS_PER_KEY = 5;
const MAX_CONSECUTIVE_FAILURES = 10;
const RETRY_DELAYS_MS = [0, 1000, 4000];

export interface WebhookRecord {
  id: string;
  keyId: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  description: string | null;
  active: boolean;
  failureCount: number;
  createdAt: string;
}

export interface Delivery {
  id: string;
  event: WebhookEvent;
  status: "success" | "failed";
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
  at: string;
}

const whKey = (id: string) => `wh:${id}`;
const indexKey = (keyId: string) => `whs:${keyId}`;
const deliveriesKey = (id: string) => `whd:${id}`;

export function publicWebhook(w: WebhookRecord) {
  const { secret: _secret, keyId: _keyId, ...rest } = w;
  return { object: "webhook", ...rest };
}

/* ------------------------------- signing helpers ------------------------------- */

export function signPayload(secret: string, timestamp: number | string, body: string): string {
  return `v1=${hmacSha256(secret, `${timestamp}.${body}`)}`;
}

/** For receivers (and our tests): verify signature and reject timestamps older than `toleranceSec`. */
export function verifySignature(secret: string, header: string, timestamp: string, body: string, toleranceSec = 300): boolean {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSec) return false;
  return safeEqual(signPayload(secret, timestamp, body), header);
}

/* ---------------------------------- CRUD ---------------------------------- */

export async function createWebhook(keyId: string, input: { url: string; events: WebhookEvent[]; description?: string }) {
  const existing = await kv().smembers(indexKey(keyId));
  if (existing.length >= MAX_WEBHOOKS_PER_KEY) {
    throw new ApiError(409, "webhook_limit_reached", `An API key can have at most ${MAX_WEBHOOKS_PER_KEY} webhooks. Delete one first.`);
  }
  await assertSafeWebhookUrl(input.url);
  const rec: WebhookRecord = {
    id: newId("wh"),
    keyId,
    url: input.url,
    events: [...new Set(input.events)],
    secret: `whsec_${randomToken(24)}`,
    description: input.description ?? null,
    active: true,
    failureCount: 0,
    createdAt: new Date().toISOString(),
  };
  await kv().set(whKey(rec.id), rec);
  await kv().sadd(indexKey(keyId), rec.id);
  return rec;
}

export async function listWebhooks(keyId: string): Promise<WebhookRecord[]> {
  const ids = await kv().smembers(indexKey(keyId));
  const all = await Promise.all(ids.map((id) => kv().get<WebhookRecord>(whKey(id))));
  return all.filter((w): w is WebhookRecord => w !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Fetch a webhook owned by `keyId`; unknown and foreign ids both yield 404. */
export async function getWebhook(id: string, keyId: string): Promise<WebhookRecord> {
  const rec = await kv().get<WebhookRecord>(whKey(id));
  if (!rec || rec.keyId !== keyId) throw new ApiError(404, "webhook_not_found", "No such webhook.");
  return rec;
}

export async function deleteWebhook(rec: WebhookRecord) {
  await kv().del(whKey(rec.id));
  await kv().del(deliveriesKey(rec.id));
  await kv().srem(indexKey(rec.keyId), rec.id);
}

export async function listDeliveries(id: string, limit = 25): Promise<Delivery[]> {
  return kv().lrange<Delivery>(deliveriesKey(id), 0, limit - 1);
}

/* -------------------------------- delivery -------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deliver one event with retries. `deadline` (epoch ms) keeps delivery inside the serverless function's
 * time limit: attempts shrink their timeout to fit and retries are skipped when there is no time left.
 */
export async function deliver(rec: WebhookRecord, type: WebhookEvent, data: unknown, deadline?: number): Promise<Delivery> {
  const started = Date.now();
  const eventId = newId("evt");
  const body = JSON.stringify({ id: eventId, type, apiVersion: "v1", createdAt: new Date().toISOString(), data });

  let attempts = 0;
  let responseStatus: number | null = null;
  let error: string | null = null;
  let success = false;

  const left = () => (deadline ?? Infinity) - Date.now();
  for (const delay of RETRY_DELAYS_MS) {
    if (attempts > 0 && left() < delay + 2500) break; // no time for a meaningful retry
    if (delay) await sleep(delay);
    attempts++;
    const timeoutMs = Math.max(1000, Math.min(8000, left() - 500));
    try {
      await assertSafeWebhookUrl(rec.url); // re-validated on every attempt (DNS may have changed)
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await fetch(rec.url, {
        method: "POST",
        redirect: "manual", // never follow redirects: they could point at internal hosts
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "RepoScribe-Webhooks/1.0",
          "X-RepoScribe-Event": type,
          "X-RepoScribe-Delivery": eventId,
          "X-RepoScribe-Timestamp": String(timestamp),
          "X-RepoScribe-Signature": signPayload(rec.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      responseStatus = res.status;
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) {
        success = true;
        error = null;
        break;
      }
      error = `Receiver responded with HTTP ${res.status}`;
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      if (!retryable) break;
    } catch (e) {
      responseStatus = null;
      error = e instanceof ApiError ? e.message : "Network error or timeout while contacting the receiver";
      if (e instanceof ApiError) break; // policy violation: do not retry
    }
  }

  const delivery: Delivery = {
    id: eventId,
    event: type,
    status: success ? "success" : "failed",
    attempts,
    responseStatus,
    error,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };

  try {
    await kv().lpush(deliveriesKey(rec.id), delivery, 25);
    const fresh = await kv().get<WebhookRecord>(whKey(rec.id)); // skip if deleted meanwhile
    if (fresh) {
      fresh.failureCount = success ? 0 : fresh.failureCount + 1;
      if (fresh.failureCount >= MAX_CONSECUTIVE_FAILURES) fresh.active = false;
      await kv().set(whKey(rec.id), fresh);
    }
  } catch (e) {
    console.error("[webhooks] failed to record delivery", e instanceof Error ? e.message : e);
  }
  return delivery;
}

/** Fan an event out to every active subscriber of `keyId`. Never throws. */
export async function dispatch(keyId: string, type: WebhookEvent, data: unknown, deadline?: number): Promise<void> {
  try {
    const hooks = (await listWebhooks(keyId)).filter((w) => w.active && w.events.includes(type));
    await Promise.allSettled(hooks.map((w) => deliver(w, type, data, deadline)));
  } catch (e) {
    console.error("[webhooks] dispatch failed", e instanceof Error ? e.message : e);
  }
}

export function jobEventData(job: DocJob) {
  return {
    id: job.id,
    status: job.status,
    source: job.source,
    repo: { fullName: job.repo.fullName, url: job.repo.url, branch: job.repo.branch, treeSha: job.repo.treeSha },
    types: Object.keys(job.documents),
    cached: job.cached,
    health: job.health ? { before: job.health.before?.score ?? null, after: job.health.after?.score ?? null } : null,
    usage: job.usage,
    warnings: job.warnings,
    error: job.error,
    links: { self: `${job.origin}/api/v1/docs/${job.id}`, markdown: `${job.origin}/api/v1/docs/${job.id}?format=markdown` },
  };
}

export async function dispatchJobEvent(job: DocJob, deadline?: number) {
  await dispatch(job.keyId, job.status === "completed" ? "doc.completed" : "doc.failed", jobEventData(job), deadline);
}

export { WEBHOOK_EVENTS };
