#!/usr/bin/env node
/**
 * End-to-end smoke test for a running RepoScribe instance (local or deployed).
 *
 *   BASE=http://127.0.0.1:3100 node scripts/e2e.mjs
 *   BASE=https://your-app.vercel.app REPO=https://github.com/octocat/Hello-World node scripts/e2e.mjs
 *
 * It creates its own API key, drives every public endpoint and checks status codes, headers and
 * payload shapes. Webhook delivery + GitHub-push sync checks run only against a local BASE
 * (a deployed instance can't reach a receiver on localhost, by design - SSRF guard).
 * NOTE: against a real deployment this performs a few real Gemini generations (free-tier quota).
 */
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";

const BASE = (process.env.BASE ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const REPO = process.env.REPO ?? "https://github.com/octocat/Hello-World";
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE);
let failed = 0;
// GitHub delivery ids must be unique per run: the server de-duplicates redeliveries by id.
const RUN = randomUUID().slice(0, 8);

class Abort extends Error {}
const abort = (msg) => {
  throw new Abort(msg);
};

const ok =(cond, name, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!cond) failed++;
  return cond;
};

async function call(method, path, { key, body, headers = {}, rawBody } = {}, attempt = 0) {
  const h = { ...headers };
  if (key) h.Authorization = `Bearer ${key}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers: h, body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  // Real deployments enforce the per-minute key limit: wait as instructed and retry instead of failing.
  if (res.status === 429 && json?.error?.code === "rate_limited" && attempt < 2) {
    const wait = Math.min(60, Number(res.headers.get("retry-after")) || 5);
    console.log(`      (rate limited, waiting ${wait}s)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return call(method, path, { key, body, headers, rawBody }, attempt + 1);
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function waitFor(fn, ms = 90_000, every = 2500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

// ---- local webhook receiver (verifies signatures exactly as a customer would) ----
const received = [];
let receiver, receiverUrl;
if (LOCAL) {
  receiver = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    received.push({ headers: req.headers, body });
    res.writeHead(200).end("ok");
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
}

const sign = (secret, ts, body) => `v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

try {
  console.log(`\nRepoScribe e2e -> ${BASE}\nrepo: ${REPO}\n`);

  // ---------- system ----------
  let r = await call("GET", "/api/v1/health");
  ok(r.status === 200 && r.json?.status === "ok", "GET /health is ok", JSON.stringify(r.json?.checks));
  ok(!!r.headers.get("x-request-id"), "responses carry X-Request-Id");
  ok(r.headers.get("access-control-allow-origin") === "*", "CORS header present");

  r = await call("GET", "/api/v1/openapi.json");
  ok(r.status === 200 && r.json?.openapi?.startsWith("3.1") && Object.keys(r.json.paths).length >= 15, "GET /openapi.json is a valid-looking OpenAPI 3.1 doc", `${Object.keys(r.json?.paths ?? {}).length} paths`);

  r = await call("OPTIONS", "/api/v1/generate");
  ok(r.status === 204, "OPTIONS preflight returns 204");

  // ---------- authentication ----------
  r = await call("POST", "/api/v1/generate", { body: { repoUrl: REPO } });
  ok(r.status === 401 && r.json?.error?.code === "missing_api_key" && r.json?.requestId, "no key -> 401 missing_api_key with error envelope");
  ok((r.headers.get("www-authenticate") ?? "").startsWith("Bearer"), "401 includes WWW-Authenticate");

  r = await call("POST", "/api/v1/generate", { key: "rsk_bad", body: { repoUrl: REPO } });
  ok(r.status === 401 && r.json?.error?.code === "invalid_api_key", "malformed key -> 401 invalid_api_key");

  r = await call("POST", "/api/v1/keys", { body: { name: "e2e main" } });
  const key = r.json?.apiKey;
  ok(r.status === 201 && /^rsk_[a-f0-9]{12}_/.test(key ?? ""), "POST /keys -> 201 with one-time apiKey");
  if (!key) throw new Error("cannot continue without an API key");

  r = await call("POST", "/api/v1/keys", { body: { name: "read only", scopes: ["read"] } });
  const readKey = r.json?.apiKey;
  if (r.status === 429) abort("Key issuance is limited per IP (KEY_ISSUE_PER_HOUR, default 10/hour). Wait, or start the server with KEY_ISSUE_PER_HOUR=1000 for repeated test runs.");
  r = await call("POST", "/api/v1/keys", { body: { name: "other tenant" } });
  const otherKey = r.json?.apiKey;
  if (!readKey || !otherKey) abort(`Could not create the extra test keys (HTTP ${r.status}): ${r.text.slice(0, 200)}`);

  r = await call("GET", "/api/v1/keys/me", { key });
  ok(r.status === 200 && r.json?.limits?.generationsPerDay > 0 && !("apiKey" in r.json) && !("secretHash" in r.json), "GET /keys/me shows limits/usage and never the secret");
  ok(!!r.headers.get("x-ratelimit-remaining"), "rate-limit headers present");

  r = await call("POST", "/api/v1/generate", { key: readKey, body: { repoUrl: REPO } });
  ok(r.status === 403 && r.json?.error?.code === "insufficient_scope", "read-only key cannot generate -> 403 insufficient_scope");

  // ---------- validation ----------
  r = await call("POST", "/api/v1/generate", { key, rawBody: "{not json", headers: { "Content-Type": "application/json" } });
  ok(r.status === 400 && r.json?.error?.code === "invalid_json", "malformed JSON -> 400");
  r = await call("POST", "/api/v1/generate", { key, body: { repoUrl: REPO, types: ["bogus"] } });
  ok(r.status === 422 && r.json?.error?.code === "validation_error" && Array.isArray(r.json.error.details), "invalid field -> 422 with details");
  r = await call("POST", "/api/v1/generate", { key, body: { repoUrl: "https://example.com/x/y" } });
  ok(r.status === 400 && r.json?.error?.code === "invalid_repo_url", "non-GitHub URL -> 400 invalid_repo_url");
  r = await call("POST", "/api/v1/analyze", { key, body: { repoUrl: "octocat/this-repo-does-not-exist-xyz" } });
  ok(r.status === 404 && r.json?.error?.code === "repo_not_found", "unknown repo -> 404 repo_not_found");

  // ---------- analyze (no LLM) ----------
  r = await call("POST", "/api/v1/analyze", { key, body: { repoUrl: REPO } });
  if (r.json?.error?.code === "github_rate_limited") {
    abort(`GitHub's anonymous API limit (60 requests/hour per IP) is exhausted. Set GITHUB_TOKEN on the server, or retry after ${new Date((r.json.error.details?.resetAt ?? 0) * 1000).toLocaleTimeString()}.`);
  }
  ok(r.status === 200 && r.json?.object === "analysis" && typeof r.json?.health?.readme?.score === "number", "POST /analyze -> 200 with README health", `score ${r.json?.health?.readme?.score}`);

  // ---------- generate (sync) ----------
  r = await call("POST", "/api/v1/generate", { key, body: { repoUrl: REPO, types: ["readme", "architecture"] } });
  ok(r.status === 201 && r.json?.status === "completed" && r.json?.documents?.readme?.markdown && r.json?.documents?.architecture, "POST /generate (sync) -> 201 with both documents", `${r.json?.usage?.durationMs}ms`);
  ok(!!r.headers.get("location") && !("keyId" in (r.json ?? {})), "Location header set; internal owner id not exposed");
  const docId = r.json?.id;
  ok(r.json?.health?.after?.score >= r.json?.health?.before?.score, "README health improved", `${r.json?.health?.before?.score} -> ${r.json?.health?.after?.score}`);

  r = await call("POST", "/api/v1/generate", { key, body: { repoUrl: REPO, types: ["readme", "architecture"] } });
  ok(r.status === 201 && r.json?.cached === true, "same repo + options again -> served from cache");

  // ---------- read / export ----------
  r = await call("GET", `/api/v1/docs/${docId}`, { key });
  ok(r.status === 200 && r.json?.id === docId, "GET /docs/{id} -> 200");
  r = await call("GET", "/api/v1/docs", { key: readKey });
  ok(r.status === 200 && r.json?.data?.length === 0, "read-scope key may list (its own, empty) documents -> 200");
  r = await call("GET", `/api/v1/docs/${docId}`, { key: readKey });
  ok(r.status === 404, "keys are isolated tenants: another key's document -> 404");
  r = await call("GET", `/api/v1/docs/${docId}?format=markdown&type=readme&download=1`, { key });
  ok(r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/markdown") && /attachment; filename="README.md"/.test(r.headers.get("content-disposition") ?? ""), "export single doc as Markdown attachment");
  r = await call("GET", `/api/v1/docs/${docId}?format=markdown`, { key });
  ok(r.status === 200 && r.text.includes("---"), "export combined Markdown");
  r = await call("GET", `/api/v1/docs/${docId}?format=pdf`, { key });
  ok(r.status === 400 && r.json?.error?.code === "invalid_format", "unknown export format -> 400");
  r = await call("GET", "/api/v1/docs", { key });
  ok(r.status === 200 && r.json?.data?.some((d) => d.id === docId), "GET /docs lists the document");
  r = await call("GET", `/api/v1/docs/${docId}`, { key: otherKey });
  ok(r.status === 404, "another API key cannot read it -> 404 (no id probing)");
  r = await call("GET", "/api/v1/docs/doc_doesnotexist", { key });
  ok(r.status === 404 && r.json?.error?.code === "document_not_found", "unknown id -> 404");

  // ---------- refine ----------
  r = await call("POST", `/api/v1/docs/${docId}/refine`, { key, body: { type: "readme", instruction: "Add a troubleshooting section" } });
  ok(r.status === 200 && r.json?.documents?.readme?.revisions === 1, "POST /docs/{id}/refine -> 200, revisions=1");

  // ---------- async + polling ----------
  r = await call("POST", "/api/v1/generate", { key, body: { repoUrl: REPO, types: ["contributing"], style: "beginner", async: true } });
  ok(r.status === 202 && !!r.headers.get("location") && ["queued", "running"].includes(r.json?.status), "async generate -> 202 + Location");
  const asyncId = r.json?.id;
  const done = await waitFor(async () => {
    const p = await call("GET", `/api/v1/docs/${asyncId}`, { key });
    return p.json?.status === "completed" || p.json?.status === "failed" ? p.json : null;
  });
  ok(done?.status === "completed" && done.documents?.contributing, "polling sees the async job complete");

  // ---------- webhooks ----------
  if (LOCAL) {
    r = await call("POST", "/api/v1/webhooks", { key, body: { url: "ftp://nope" } });
    ok(r.status === 422 && r.json?.error?.code === "invalid_webhook_url", "non-http(s) webhook URL rejected -> 422");

    r = await call("POST", "/api/v1/webhooks", { key, body: { url: receiverUrl, events: ["doc.completed", "doc.failed", "sync.triggered", "ping"] } });
    const hook = r.json;
    ok(r.status === 201 && /^whsec_/.test(hook?.secret ?? ""), "POST /webhooks -> 201 with one-time signing secret");
    r = await call("GET", `/api/v1/webhooks/${hook.id}`, { key });
    ok(r.status === 200 && !("secret" in r.json), "GET /webhooks/{id} never returns the secret");

    r = await call("POST", `/api/v1/webhooks/${hook.id}/test`, { key });
    ok(r.status === 200 && r.json?.status === "success" && r.json?.responseStatus === 200, "POST /webhooks/{id}/test delivers a ping");
    const ping = received.find((x) => x.headers["x-reposcribe-event"] === "ping");
    ok(!!ping && ping.headers["x-reposcribe-signature"] === sign(hook.secret, ping.headers["x-reposcribe-timestamp"], ping.body), "receiver verifies the HMAC signature");
    ok(JSON.parse(ping?.body ?? "{}").type === "ping" && /^evt_/.test(JSON.parse(ping?.body ?? "{}").id ?? ""), "payload is a JSON event envelope");

    // doc.completed fires after an async generation
    r = await call("POST", "/api/v1/generate", { key, body: { repoUrl: REPO, types: ["api"], async: true } });
    const wid = r.json?.id;
    const evt = await waitFor(() => received.map((x) => JSON.parse(x.body)).find((e) => e.type === "doc.completed" && e.data?.id === wid));
    ok(!!evt, "doc.completed webhook delivered after generation", evt ? `types=${evt.data.types}` : "");
    ok(evt?.data?.links?.self?.endsWith(`/api/v1/docs/${wid}`), "event links back to the document");

    r = await call("GET", `/api/v1/webhooks/${hook.id}/deliveries`, { key });
    ok(r.status === 200 && r.json?.data?.length >= 2 && r.json.data.every((d) => d.status === "success"), "delivery log records attempts", `${r.json?.data?.length} entries`);
    r = await call("GET", `/api/v1/webhooks/${hook.id}`, { key: otherKey });
    ok(r.status === 404, "another key cannot see this webhook -> 404");

    // ---------- GitHub push sync ----------
    r = await call("POST", "/api/v1/sync", { key, body: { repoUrl: REPO, types: ["readme"] } });
    const sync = r.json;
    ok(r.status === 201 && /\/api\/v1\/hooks\/github\//.test(sync?.payloadUrl ?? "") && /^ghsec_/.test(sync?.secret ?? ""), "POST /sync -> 201 with payloadUrl + secret");
    const path = new URL(sync.payloadUrl).pathname;
    const push = JSON.stringify({ ref: "refs/heads/master", repository: { full_name: "octocat/Hello-World", default_branch: "master" } });
    const gh = (event, delivery, body = push, secret = sync.secret) => ({
      rawBody: body,
      headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": `${RUN}-${delivery}`, "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
    });

    r = await call("POST", path, gh("push", "x1", push, "wrong"));
    ok(r.status === 401 && r.json?.error?.code === "invalid_signature", "push with bad signature -> 401");
    r = await call("POST", path, gh("ping", "x2"));
    ok(r.status === 200 && r.json?.message === "pong", "GitHub ping -> 200 pong");
    r = await call("POST", path, gh("push", "x3"));
    ok(r.status === 202 && r.json?.status === "queued" && r.json?.docId, "signed push -> 202 queued");
    const syncDoc = r.json?.docId;
    const trig = await waitFor(() => received.map((x) => JSON.parse(x.body)).find((e) => e.type === "sync.triggered" && e.data?.docId === syncDoc));
    ok(!!trig, "sync.triggered webhook delivered");
    const syncDone = await waitFor(async () => {
      const p = await call("GET", `/api/v1/docs/${syncDoc}`, { key });
      return p.json?.status === "completed" || p.json?.status === "failed" ? p.json : null; // stop as soon as it settles
    });
    ok(syncDone?.status === "completed" && syncDone?.source === "sync", "pushed job completed with source=sync", syncDone?.error?.code ?? "");
    r = await call("POST", path, gh("push", "x3"));
    ok(r.status === 200 && r.json?.ignored === "duplicate", "redelivered event is ignored (idempotent)");
    r = await call("POST", path, gh("push", "x4"));
    ok(r.status === 200 && r.json?.ignored === "debounced", "rapid second push is debounced");
    r = await call("DELETE", `/api/v1/sync/${sync.id}`, { key });
    ok(r.status === 204, "DELETE /sync/{id} -> 204");
    r = await call("POST", path, gh("push", "x5"));
    ok(r.status === 404, "deleted sync endpoint -> 404");

    r = await call("DELETE", `/api/v1/webhooks/${hook.id}`, { key });
    ok(r.status === 204, "DELETE /webhooks/{id} -> 204");
  } else {
    console.log("SKIP  webhook + push-sync checks (BASE is not local)");
  }

  // ---------- key lifecycle ----------
  r = await call("DELETE", `/api/v1/docs/${docId}`, { key });
  ok(r.status === 204, "DELETE /docs/{id} -> 204");
  r = await call("GET", `/api/v1/docs/${docId}`, { key });
  ok(r.status === 404, "deleted doc -> 404");

  r = await call("POST", "/api/v1/keys/me/rotate", { key: otherKey });
  const rotated = r.json?.apiKey;
  ok(r.status === 200 && rotated && rotated !== otherKey, "POST /keys/me/rotate -> new secret");
  r = await call("GET", "/api/v1/keys/me", { key: otherKey });
  ok(r.status === 401, "old secret stops working immediately");
  r = await call("DELETE", "/api/v1/keys/me", { key: rotated });
  ok(r.status === 204, "DELETE /keys/me revokes the key");
  r = await call("GET", "/api/v1/keys/me", { key: rotated });
  ok(r.status === 401 && r.json?.error?.code === "revoked_api_key", "revoked key -> 401 revoked_api_key");
} catch (e) {
  if (e instanceof Abort) console.error(`\nABORTED: ${e.message}`);
  else console.error("\nFATAL", e);
  failed++;
} finally {
  receiver?.close();
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
