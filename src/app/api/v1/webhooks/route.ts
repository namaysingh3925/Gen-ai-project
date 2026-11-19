import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { json, preflight, readJson, route } from "@/lib/http";
import { WEBHOOK_EVENTS } from "@/lib/types";
import { createWebhook, listWebhooks, publicWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";
export const OPTIONS = preflight;

const schema = z.object({
  url: z.string().trim().min(1).max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).default(["doc.completed", "doc.failed"]),
  description: z.string().trim().max(120).optional(),
});

export const GET = route(async (c) => {
  const key = await authenticate(c, "webhooks");
  const hooks = await listWebhooks(key.id);
  return json({ object: "list", data: hooks.map(publicWebhook) });
});

/** Register a webhook. The signing secret is returned ONCE, in this response. */
export const POST = route(async (c) => {
  const key = await authenticate(c, "webhooks");
  const body = await readJson(c.req, schema);
  const rec = await createWebhook(key.id, body);
  return json(
    { ...publicWebhook(rec), secret: rec.secret, note: "Store the secret now - it is only shown once. Use it to verify X-RepoScribe-Signature." },
    201,
    { Location: `${c.origin}/api/v1/webhooks/${rec.id}` },
  );
});
