import { z } from "zod";
import { createKey, publicKey } from "@/lib/auth";
import { sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";
import { clientIp, json, preflight, readJson, route } from "@/lib/http";
import { hit, rateLimitedError } from "@/lib/ratelimit";
import { ALL_SCOPES } from "@/lib/types";

export const runtime = "nodejs";
export const OPTIONS = preflight;

const schema = z.object({
  name: z.string().trim().min(1).max(60).default("My API key"),
  scopes: z.array(z.enum(ALL_SCOPES)).min(1).optional(),
});

/** Self-service key issuance. Public, but limited per client IP (the IP is hashed before use). */
export const POST = route(async (c) => {
  const bucket = `issue:${sha256(clientIp(c.req)).slice(0, 16)}`;
  const rate = await hit(bucket, env.keyIssuePerHour, 3600);
  if (!rate.allowed) throw rateLimitedError(rate, "API key requests");

  const body = await readJson(c.req, schema);
  const { record, apiKey } = await createKey(body.name, body.scopes ?? [...ALL_SCOPES]);
  return json({ ...publicKey(record), apiKey, warning: "Store this key now - it will not be shown again." }, 201);
});
