import { APP_VERSION, env } from "@/lib/env";
import { json, preflight, route } from "@/lib/http";
import { kv, storeKind } from "@/lib/store";

export const runtime = "nodejs";
export const OPTIONS = preflight;

/** Public liveness/readiness probe. Reveals configuration *state* only, never values. */
export const GET = route(async () => {
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
  const llm = env.geminiKey ? "configured" : "missing";
  const ok = storeOk && llm === "configured";
  return json(
    {
      status: ok ? "ok" : "degraded",
      version: APP_VERSION,
      time: new Date().toISOString(),
      checks: { store, llm, github: env.githubToken ? "authenticated" : "anonymous" },
    },
    ok ? 200 : 503,
  );
});
