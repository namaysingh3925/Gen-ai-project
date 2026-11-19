import { json, preflight, route } from "@/lib/http";
import { buildOpenApi } from "@/lib/openapi";

export const runtime = "nodejs";
export const OPTIONS = preflight;

export const GET = route(async (c) => json(buildOpenApi(c.origin), 200, { "Cache-Control": "public, max-age=300" }));
