/**
 * Structured API keys.
 *
 *   rsk_<keyId:12 hex>_<secret:32 base64url>
 *
 * Only a SHA-256 hash of the secret is stored (the secret is high-entropy random, so a fast hash is
 * appropriate). The keyId prefix gives O(1) lookup. Keys carry scopes and per-key rate limits,
 * can be rotated and revoked, and the plaintext key is shown exactly once at creation/rotation.
 */
import { randomBytes } from "node:crypto";
import { safeEqual, sha256 } from "./crypto";
import { env } from "./env";
import { ApiError, type Ctx } from "./http";
import { applyRateHeaders, hit, rateLimitedError } from "./ratelimit";
import { kv } from "./store";
import type { Scope } from "./types";
import { ALL_SCOPES } from "./types";

const KEY_RE = /^rsk_([a-f0-9]{12})_([A-Za-z0-9_-]{32})$/;

export interface ApiKeyRecord {
  id: string;
  name: string;
  secretHash: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface PublicKey {
  id: string;
  name: string;
  scopes: Scope[];
  keyPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

const keyStoreId = (id: string) => `key:${id}`;

export function publicKey(rec: ApiKeyRecord): PublicKey {
  return {
    id: rec.id,
    name: rec.name,
    scopes: rec.scopes,
    keyPreview: `rsk_${rec.id}_${"*".repeat(8)}`,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt ?? null,
    revoked: Boolean(rec.revokedAt),
  };
}

function mintSecret() {
  return randomBytes(24).toString("base64url");
}

export async function createKey(name: string, scopes: Scope[]) {
  const id = randomBytes(6).toString("hex");
  const secret = mintSecret();
  const record: ApiKeyRecord = {
    id,
    name,
    secretHash: sha256(secret),
    scopes: scopes.length ? scopes : [...ALL_SCOPES],
    createdAt: new Date().toISOString(),
  };
  await kv().set(keyStoreId(id), record);
  return { record, apiKey: `rsk_${id}_${secret}` };
}

export async function rotateKey(record: ApiKeyRecord) {
  const secret = mintSecret();
  const next: ApiKeyRecord = { ...record, secretHash: sha256(secret), lastUsedAt: undefined };
  await kv().set(keyStoreId(record.id), next);
  return { record: next, apiKey: `rsk_${record.id}_${secret}` };
}

export async function revokeKey(record: ApiKeyRecord) {
  await kv().set(keyStoreId(record.id), { ...record, revokedAt: new Date().toISOString() });
}

export function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    return m ? m[1].trim() : "";
  }
  return req.headers.get("x-api-key")?.trim() ?? null;
}

const WWW_AUTH = { "WWW-Authenticate": 'Bearer realm="reposcribe"' };

/**
 * Authenticate a request, enforce the required scope and the per-key rate limit.
 * 401 = missing/invalid/revoked key, 403 = key lacks the scope, 429 = rate limited.
 */
export async function authenticate(c: Ctx<any>, scope?: Scope): Promise<ApiKeyRecord> {
  const token = extractToken(c.req);
  if (token === null) {
    throw new ApiError(401, "missing_api_key", "Provide your API key as `Authorization: Bearer <key>` (or the X-API-Key header).", undefined, WWW_AUTH);
  }
  const m = KEY_RE.exec(token);
  if (!m) throw new ApiError(401, "invalid_api_key", "The API key is malformed.", undefined, WWW_AUTH);

  const record = await kv().get<ApiKeyRecord>(keyStoreId(m[1]));
  // Same error for unknown id and wrong secret so key ids cannot be enumerated.
  if (!record || !safeEqual(record.secretHash, sha256(m[2]))) {
    throw new ApiError(401, "invalid_api_key", "The API key is not valid.", undefined, WWW_AUTH);
  }
  if (record.revokedAt) {
    throw new ApiError(401, "revoked_api_key", "This API key has been revoked.", undefined, WWW_AUTH);
  }
  if (scope && !record.scopes.includes(scope)) {
    throw new ApiError(403, "insufficient_scope", `This API key lacks the required scope: ${scope}.`, {
      required: scope,
      granted: record.scopes,
    });
  }

  const rate = await hit(`k:${record.id}:min`, env.ratePerMinute, 60);
  applyRateHeaders(c.headers, rate);
  if (!rate.allowed) throw rateLimitedError(rate, "requests");

  // "Last used" lives under its own key (never rewrite the record: a stale write could undo a revoke).
  // Throttled to once a minute per key to keep store traffic low.
  const lastUsed = await kv().get<string>(`keyuse:${record.id}`);
  if (!lastUsed || Date.now() - Date.parse(lastUsed) > 60_000) {
    record.lastUsedAt = new Date().toISOString();
    void kv().set(`keyuse:${record.id}`, record.lastUsedAt).catch(() => {});
  } else {
    record.lastUsedAt = lastUsed;
  }
  return record;
}
