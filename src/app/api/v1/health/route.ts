import { APP_VERSION, env } from "@/lib/env";
import { checkGemini } from "@/lib/gemini";
import { json, preflight, route } from "@/lib/http";
import { kv, storeKind } from "@/lib/store";

export const runtime = "nodejs";
export const OPTIONS = preflight;

/**
 * Public liveness/readiness probe. Reveals configuration *state* only, never values.
 * `?deep=1` also verifies the Gemini key and model with a free metadata call (cached 60 s).
 */
export const GET = route(async (c) => {
  const deep = new URL(c.req.url).searchParams.get("deep") === "1";
  const kind = storeKind();
  let store: string = kind;
  let storeOk = false;
  if (kind !== "missing") {
    try {
      storeOk = await kv().ping();
    } catch {
      store = "unreachable";
    }
  }

  let llm = env.geminiKey ? "configured" : "missing";
  let llmModel: string | undefined;
  if (deep && env.geminiKey) {
    const check = await checkGemini();
    llm = check.status;
    llmModel = check.model;
  }
  const llmOk = deep ? llm === "ok" : llm === "configured";
  const ok = storeOk && llmOk;

  return json(
    {
      status: ok ? "ok" : "degraded",
      version: APP_VERSION,
      time: new Date().toISOString(),
      checks: { store, llm, ...(llmModel ? { llmModel } : {}), github: env.githubToken ? "authenticated" : "anonymous" },
    },
    ok ? 200 : 503,
  );
});
