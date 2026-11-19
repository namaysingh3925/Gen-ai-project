import { authenticate } from "@/lib/auth";
import { json, preflight, route } from "@/lib/http";
import { getWebhook, listDeliveries } from "@/lib/webhooks";

export const runtime = "nodejs";
export const OPTIONS = preflight;

/** The 25 most recent delivery attempts for a webhook (status codes, retries, errors). */
export const GET = route<{ id: string }>(async (c) => {
  const key = await authenticate(c, "webhooks");
  const hook = await getWebhook(c.params.id, key.id);
  return json({ object: "list", data: await listDeliveries(hook.id) });
});
