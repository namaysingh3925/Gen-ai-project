/**
 * "Auto-sync": an INCOMING webhook. The user registers a repository, we hand back a payload URL
 * and a secret, they paste both into GitHub (Settings -> Webhooks, content type JSON, "push" event).
 * On every push to the tracked branch we verify GitHub's HMAC signature (X-Hub-Signature-256) and
 * regenerate the docs, then notify the owner's outbound webhooks (`sync.triggered`, `doc.completed`).
 */
import { hmacSha256, newId, randomToken, safeEqual } from "./crypto";
import { createJob, type GenerateInput } from "./generate";
import { ApiError } from "./http";
import { assertQuotaAvailable } from "./ratelimit";
import { parseRepoUrl } from "./github";
import { kv } from "./store";
import type { DocJob } from "./types";

export const MAX_SYNCS_PER_KEY = 5;

export interface SyncRecord {
  id: string;
  keyId: string;
  fullName: string;
  repoUrl: string;
  options: Omit<GenerateInput, "repoUrl" | "async">;
  hookToken: string;
  secret: string;
  createdAt: string;
  lastTriggeredAt: string | null;
  triggerCount: number;
}

const syncKey = (id: string) => `sync:${id}`;
const tokenKey = (t: string) => `synctok:${t}`;
const indexKey = (keyId: string) => `syncs:${keyId}`;

export function publicSync(rec: SyncRecord, origin: string, includeSecret = false) {
  return {
    object: "sync",
    id: rec.id,
    repo: rec.fullName,
    options: rec.options,
    payloadUrl: `${origin}/api/v1/hooks/github/${rec.hookToken}`,
    ...(includeSecret ? { secret: rec.secret } : {}),
    createdAt: rec.createdAt,
    lastTriggeredAt: rec.lastTriggeredAt,
    triggerCount: rec.triggerCount,
  };
}

export async function createSync(keyId: string, input: Omit<GenerateInput, "async">): Promise<SyncRecord> {
  const existing = await kv().smembers(indexKey(keyId));
  if (existing.length >= MAX_SYNCS_PER_KEY) {
    throw new ApiError(409, "sync_limit_reached", `An API key can have at most ${MAX_SYNCS_PER_KEY} synced repositories.`);
  }
  const ref = parseRepoUrl(input.repoUrl);
  const { repoUrl: _repoUrl, ...options } = input;
  const rec: SyncRecord = {
    id: newId("sync"),
    keyId,
    fullName: `${ref.owner}/${ref.name}`,
    repoUrl: `https://github.com/${ref.owner}/${ref.name}`,
    options: { ...options, branch: input.branch ?? ref.branch },
    hookToken: randomToken(24),
    secret: `ghsec_${randomToken(24)}`,
    createdAt: new Date().toISOString(),
    lastTriggeredAt: null,
    triggerCount: 0,
  };
  await kv().set(syncKey(rec.id), rec);
  await kv().set(tokenKey(rec.hookToken), rec.id);
  await kv().sadd(indexKey(keyId), rec.id);
  return rec;
}

export async function listSyncs(keyId: string): Promise<SyncRecord[]> {
  const ids = await kv().smembers(indexKey(keyId));
  const all = await Promise.all(ids.map((id) => kv().get<SyncRecord>(syncKey(id))));
  return all.filter((s): s is SyncRecord => s !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getSync(id: string, keyId: string): Promise<SyncRecord> {
  const rec = await kv().get<SyncRecord>(syncKey(id));
  if (!rec || rec.keyId !== keyId) throw new ApiError(404, "sync_not_found", "No such sync subscription.");
  return rec;
}

export async function deleteSync(rec: SyncRecord) {
  await kv().del(syncKey(rec.id));
  await kv().del(tokenKey(rec.hookToken));
  await kv().srem(indexKey(rec.keyId), rec.id);
}

export interface PushResult {
  status: number;
  body: Record<string, unknown>;
  job?: DocJob;
  sync?: SyncRecord;
}

/** Verify + interpret one GitHub webhook delivery. The caller runs the returned job in the background. */
export async function processGithubDelivery(token: string, rawBody: string, headers: Headers, origin: string): Promise<PushResult> {
  const id = await kv().get<string>(tokenKey(token));
  const rec = id ? await kv().get<SyncRecord>(syncKey(id)) : null;
  if (!rec) throw new ApiError(404, "hook_not_found", "Unknown webhook endpoint.");

  const signature = headers.get("x-hub-signature-256") ?? "";
  const expected = `sha256=${hmacSha256(rec.secret, rawBody)}`;
  if (!signature || !safeEqual(signature, expected)) {
    throw new ApiError(401, "invalid_signature", "The X-Hub-Signature-256 header is missing or does not match.");
  }

  const event = headers.get("x-github-event") ?? "";
  if (event === "ping") return { status: 200, body: { ok: true, message: "pong", repo: rec.fullName } };
  if (event !== "push") return { status: 200, body: { ignored: "event", event } };

  const delivery = headers.get("x-github-delivery");
  if (delivery && !(await kv().setnx(`ghd:${delivery}`, 1, 86400))) {
    return { status: 200, body: { ignored: "duplicate", delivery } };
  }

  let payload: { ref?: string; deleted?: boolean; repository?: { full_name?: string; default_branch?: string } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new ApiError(400, "invalid_json", "Push payload is not valid JSON.");
  }
  if (payload.repository?.full_name?.toLowerCase() !== rec.fullName.toLowerCase()) {
    throw new ApiError(400, "repository_mismatch", "This endpoint is registered for a different repository.");
  }
  if (payload.deleted) return { status: 200, body: { ignored: "branch_deleted" } };

  const pushed = (payload.ref ?? "").replace(/^refs\/heads\//, "");
  const tracked = rec.options.branch ?? payload.repository?.default_branch;
  if (!tracked || pushed !== tracked) return { status: 200, body: { ignored: "branch", branch: pushed, tracking: tracked ?? null } };

  // Debounce bursts of pushes (also protects the Gemini quota).
  if (!(await kv().setnx(`syncdebounce:${rec.id}`, 1, 60))) {
    return { status: 200, body: { ignored: "debounced", retryAfterSeconds: 60 } };
  }
  await assertQuotaAvailable(rec.keyId);

  const job = await createJob({ ...rec.options, repoUrl: rec.repoUrl, async: true }, rec.keyId, origin, "sync");
  rec.lastTriggeredAt = new Date().toISOString();
  rec.triggerCount += 1;
  await kv().set(syncKey(rec.id), rec);
  return { status: 202, body: { status: "queued", docId: job.id, branch: pushed }, job, sync: rec };
}
