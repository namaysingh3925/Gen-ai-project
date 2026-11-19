import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateText, resetGeminiForTests } from "@/lib/gemini";
import { readBody, startServer } from "./helpers";

const okBody = (text = "# Hello") => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 },
});

beforeEach(() => {
  resetGeminiForTests();
  process.env.GEMINI_API_KEY = "test-key-123";
  process.env.GEMINI_MODEL = "primary-model";
  process.env.GEMINI_FALLBACK_MODELS = "fallback-model";
});
afterEach(() => {
  for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_FALLBACK_MODELS", "GEMINI_BASE_URL"]) delete process.env[k];
});

const req = { system: "SYS", prompt: "USER PROMPT" };

describe("Gemini client", () => {
  it("calls generateContent directly, keeps the key in a header and parses text + usage", async () => {
    let captured: { url?: string; key?: unknown; body?: Record<string, unknown> } = {};
    const srv = await startServer(async (r, res) => {
      captured = { url: r.url, key: r.headers["x-goog-api-key"], body: JSON.parse(await readBody(r)) };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(okBody("# Doc")));
    });
    process.env.GEMINI_BASE_URL = srv.url;
    try {
      const out = await generateText(req);
      expect(out).toMatchObject({ text: "# Doc", model: "primary-model", promptTokens: 12, outputTokens: 34, finishReason: "STOP" });
      expect(captured.url).toBe("/v1beta/models/primary-model:generateContent");
      expect(captured.url).not.toContain("test-key-123"); // never in the URL
      expect(captured.key).toBe("test-key-123");
      expect(captured.body).toMatchObject({
        systemInstruction: { parts: [{ text: "SYS" }] },
        contents: [{ role: "user", parts: [{ text: "USER PROMPT" }] }],
      });
    } finally {
      await srv.close();
    }
  });

  it("falls back to the next model when the first is unknown (404) and remembers the working one", async () => {
    const paths: string[] = [];
    const srv = await startServer((r, res) => {
      paths.push(r.url!);
      if (r.url!.includes("primary-model")) res.writeHead(404).end(JSON.stringify({ error: { message: "model not found" } }));
      else res.writeHead(200).end(JSON.stringify(okBody()));
    });
    process.env.GEMINI_BASE_URL = srv.url;
    try {
      expect((await generateText(req)).model).toBe("fallback-model");
      await generateText(req);
      expect(paths.filter((p) => p.includes("primary-model"))).toHaveLength(1); // not retried on the 2nd call
    } finally {
      await srv.close();
    }
  });

  it("retries transient 503s with backoff", async () => {
    let hits = 0;
    const srv = await startServer((_r, res) => {
      if (++hits < 3) res.writeHead(503).end(JSON.stringify({ error: { message: "overloaded" } }));
      else res.writeHead(200).end(JSON.stringify(okBody()));
    });
    process.env.GEMINI_BASE_URL = srv.url;
    try {
      expect((await generateText(req)).text).toBe("# Hello");
      expect(hits).toBe(3);
    } finally {
      await srv.close();
    }
  }, 20_000);

  it("maps rejected credentials to a safe 502 without leaking upstream detail", async () => {
    const srv = await startServer((_r, res) => res.writeHead(400).end(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } })));
    process.env.GEMINI_BASE_URL = srv.url;
    try {
      const err = await generateText(req).catch((e) => e);
      expect(err).toMatchObject({ status: 502, code: "llm_auth_error" });
      expect(err.message).not.toContain("test-key-123");
    } finally {
      await srv.close();
    }
  });

  it("maps safety blocks, empty answers and missing configuration", async () => {
    let mode: "blocked" | "empty" = "blocked";
    const srv = await startServer((_r, res) => {
      res.writeHead(200).end(JSON.stringify(mode === "blocked" ? { promptFeedback: { blockReason: "SAFETY" } } : { candidates: [{ content: { parts: [] } }] }));
    });
    process.env.GEMINI_BASE_URL = srv.url;
    try {
      await expect(generateText(req)).rejects.toMatchObject({ status: 422, code: "llm_blocked" });
      mode = "empty";
      await expect(generateText(req)).rejects.toMatchObject({ status: 502, code: "llm_empty_response" });
      delete process.env.GEMINI_API_KEY;
      await expect(generateText(req)).rejects.toMatchObject({ status: 503, code: "llm_not_configured" });
    } finally {
      await srv.close();
    }
  });

  it("surfaces persistent rate limiting as 429 with Retry-After", async () => {
    const srv = await startServer((_r, res) => res.writeHead(429, { "Retry-After": "1" }).end(JSON.stringify({ error: { message: "quota" } })));
    process.env.GEMINI_BASE_URL = srv.url;
    try {
      const err = await generateText(req).catch((e) => e);
      expect(err).toMatchObject({ status: 429, code: "llm_rate_limited" });
      expect(err.headers["Retry-After"]).toBeDefined();
    } finally {
      await srv.close();
    }
  }, 20_000);
});
