import { authenticate } from "@/lib/auth";
import { json, preflight, route } from "@/lib/http";
import { deliver, getWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";
export const maxDuration = 30;
export const OPTIONS = preflight;

/** Send a signed `ping` event to the webhook right now and report the delivery result. */
export const POST = route<{ id: string }>(async (c) => {
  const key = await authenticate(c, "webhooks");
  const hook = await getWebhook(c.params.id, key.id);
  const delivery = await deliver(hook, "ping", { message: "Hello from RepoScribe", webhookId: hook.id });
  return json({ object: "delivery", ...delivery });
});
