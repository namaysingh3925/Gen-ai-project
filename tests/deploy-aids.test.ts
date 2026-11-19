import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/lib/env";
import { checkGemini, resetGeminiForTests } from "@/lib/gemini";
import { resetStoreForTests } from "@/lib/store";
import { createWebhook, deliver } from "@/lib/webhooks";
import { startServer } from "./helpers";

const REDIS_VARS = /^(UPSTASH_REDIS_REST_|KV_REST_API_|MYSTORE_REST_API_|OTHER_REST_API_)/;
const clearRedisVars = () => {
  for (const k of Object.keys(process.env)) if (REDIS_VARS.test(k)) delete process.env[k];
};

describe("Upstash credential discovery", () => {
  beforeEach(clearRedisVars);
  afterEach(clearRedisVars);

  it("prefers UPSTASH_REDIS_*, then KV_REST_API_*", () => {
    process.env.KV_REST_API_URL = "https://kv.example.upstash.io/";
    process.env.KV_REST_API_TOKEN = "kv-token";
    expect([env.redisUrl, env.redisToken]).toEqual(["https://kv.example.upstash.io", "kv-token"]);
    process.env.UPSTASH_REDIS_REST_URL = "https://up.example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "up-token";
    expect([env.redisUrl, env.redisToken]).toEqual(["https://up.example.upstash.io", "up-token"]);
  });

  it("finds a pair under a custom prefix chosen in Vercel's Connect dialog", () => {
    process.env.MYSTORE_REST_API_URL = "https://custom.upstash.io";
    process.env.MYSTORE_REST_API_TOKEN = "custom-token";
    process.env.MYSTORE_REST_API_READ_ONLY_TOKEN = "read-only";
    expect([env.redisUrl, env.redisToken]).toEqual(["https://custom.upstash.io", "custom-token"]);
  });

  it("ignores half pairs and non-https URLs", () => {
    process.env.OTHER_REST_API_URL = "http://insecure.example";
    process.env.OTHER_REST_API_TOKEN = "t";
    process.env.KV_REST_API_URL = "https://only-url.upstash.io";
    expect(env.redisUrl).toBe("");
    expect(env.redisToken).toBe("");
  });
});

describe("checkGemini (deep health check)", () => {
  beforeEach(() => {
    resetGeminiForTests();
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "primary";
    process.env.GEMINI_FALLBACK_MODELS = "fallback";
  });
  afterEach(() => {
    for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_FALLBACK_MODELS", "GEMINI_BASE_URL"]) delete process.env[k];
  });

  it("reports ok with the first available model, using a metadata GET (no generation)", async () => {
    const seen: string[] = [];
    const srv = await startServer((req, res) => {
      seen.push(`${req.method} ${req.url} key=${req.headers["x-goog-api-key"]}`);
      res.writeHead(req.url?.includes("primary") ? 404 : 200).end("{}");
    });
    process.env.GEMINI_BASE_URL = srv.url;
    try {
      expect(await checkGemini()).toEqual({ status: "ok", model: "fallback" });
      expect(seen).toEqual(["GET /v1beta/models/primary key=test-key", "GET /v1beta/models/fallback key=test-key"]);
      await checkGemini(); // cached for 60 s
      expect(seen).toHaveLength(2);
    } finally {
      await srv.close();
    }
  });

  it("distinguishes a bad key, a missing key and an unknown model", async () => {
    let status = 400;
    const srv = await startServer((_req, res) => res.writeHead(status).end("{}"));
    process.env.GEMINI_BASE_URL = srv.url;
    try {
      expect((await checkGemini()).status).toBe("invalid_key");
      resetGeminiForTests();
      status = 404;
      expect((await checkGemini()).status).toBe("model_not_found");
      resetGeminiForTests();
      delete process.env.GEMINI_API_KEY;
      expect((await checkGemini()).status).toBe("missing_key");
    } finally {
      await srv.close();
    }
  });
});

describe("deadline-aware webhook delivery", () => {
  beforeEach(() => resetStoreForTests());

  it("skips retries that cannot finish before the function deadline", async () => {
    let hits = 0;
    const srv = await startServer((_req, res) => {
      hits++;
      res.writeHead(503).end();
    });
    try {
      const hook = await createWebhook("k", { url: `${srv.url}/h`, events: ["ping"] });
      const started = Date.now();
      const d = await deliver(hook, "ping", {}, Date.now() + 2000);
      expect(d).toMatchObject({ status: "failed", attempts: 1, responseStatus: 503 });
      expect(hits).toBe(1);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await srv.close();
    }
  });
});

describe("browser client key issuance", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("mints exactly one key when several requests start at once", async () => {
    let minted = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/v1/keys") {
          minted++;
          await new Promise((r) => setTimeout(r, 20));
          return new Response(JSON.stringify({ apiKey: `rsk_${"a".repeat(12)}_${String(minted).padStart(32, "x")}` }), { status: 201 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const { api, getStoredKey } = await import("@/lib/client");
    await Promise.all([api("/api/v1/keys/me"), api("/api/v1/webhooks"), api("/api/v1/sync")]);
    expect(minted).toBe(1);
    expect(getStoredKey()).toMatch(/^rsk_a{12}_/);
  });
});
