/**
 * Direct Gemini integration (REST `generateContent`, no SDK/wrapper).
 *  - API key is sent in the `x-goog-api-key` header (never in the URL, so it can't leak into logs).
 *  - Retries 429/5xx with exponential backoff (honouring Retry-After) inside a deadline.
 *  - If a model id is unknown (404) it transparently falls back to GEMINI_FALLBACK_MODELS.
 */
import { env } from "./env";
import { ApiError } from "./http";

export interface LlmRequest {
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Absolute epoch-ms deadline for the whole call (including retries). */
  deadline?: number;
}

export interface LlmResult {
  text: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  finishReason: string;
}

class ModelNotFound extends Error {}

let workingModel: string | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function resetGeminiForTests() {
  workingModel = null;
}

function modelCandidates(): string[] {
  const list = [workingModel, env.geminiModel, ...env.geminiFallbacks].filter((m): m is string => Boolean(m));
  return [...new Set(list)];
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
}

async function callModel(model: string, req: LlmRequest): Promise<LlmResult> {
  const id = model.replace(/^models\//, "");
  const url = `${env.geminiBaseUrl}/v1beta/models/${encodeURIComponent(id)}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.prompt }] }],
    generationConfig: { temperature: req.temperature ?? 0.4, maxOutputTokens: req.maxOutputTokens ?? 8192 },
  });

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = (req.deadline ?? Infinity) - Date.now();
    if (remaining < 4000) throw new ApiError(504, "llm_timeout", "Ran out of time before Gemini could respond.");

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.geminiKey },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(50_000, remaining)),
      });
    } catch {
      if (attempt < maxAttempts) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new ApiError(504, "llm_timeout", "Gemini did not respond in time. Try again.");
    }

    if (res.ok) {
      const data = (await res.json()) as GeminiResponse;
      if (data.promptFeedback?.blockReason) {
        throw new ApiError(422, "llm_blocked", `Gemini declined to process this repository content (${data.promptFeedback.blockReason}).`);
      }
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? [])
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("")
        .trim();
      if (!text) throw new ApiError(502, "llm_empty_response", "Gemini returned an empty response. Try again.");
      return {
        text,
        model: id,
        promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        finishReason: cand?.finishReason ?? "UNKNOWN",
      };
    }

    const errBody = (await res.json().catch(() => ({}))) as GeminiResponse;
    const message = errBody.error?.message ?? "";

    if (res.status === 404) throw new ModelNotFound(id);
    if (res.status === 401 || res.status === 403 || /api key not valid|API_KEY_INVALID/i.test(message)) {
      console.error("[gemini] credential problem:", res.status, errBody.error?.status);
      throw new ApiError(502, "llm_auth_error", "The server's Gemini credentials were rejected. Check GEMINI_API_KEY.");
    }
    if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Math.min(8000, retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** (attempt - 1) + Math.random() * 400);
      await sleep(wait);
      continue;
    }
    if (res.status === 429) {
      throw new ApiError(429, "llm_rate_limited", "The Gemini free-tier rate limit was hit. Wait a minute and try again.", undefined, {
        "Retry-After": "30",
      });
    }
    if (RETRYABLE.has(res.status)) {
      throw new ApiError(502, "llm_unavailable", "Gemini is temporarily unavailable. Try again shortly.");
    }
    console.error("[gemini] request rejected:", res.status, message.slice(0, 200));
    throw new ApiError(502, "llm_bad_request", `Gemini rejected the request (${res.status}).`);
  }
  throw new ApiError(502, "llm_unavailable", "Gemini is temporarily unavailable. Try again shortly.");
}

export async function generateText(req: LlmRequest): Promise<LlmResult> {
  if (!env.geminiKey) {
    throw new ApiError(503, "llm_not_configured", "The server has no GEMINI_API_KEY configured.");
  }
  for (const model of modelCandidates()) {
    try {
      const result = await callModel(model, req);
      workingModel = model;
      return result;
    } catch (e) {
      if (e instanceof ModelNotFound) continue;
      throw e;
    }
  }
  throw new ApiError(502, "llm_model_unavailable", "None of the configured Gemini models are available. Check GEMINI_MODEL.");
}
