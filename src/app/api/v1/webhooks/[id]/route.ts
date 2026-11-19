import { authenticate } from "@/lib/auth";
import { json, noContent, preflight, route } from "@/lib/http";
import { deleteWebhook, getWebhook, publicWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";
export const OPTIONS = preflight;

export const GET = route<{ id: string }>(async (c) => {
  const key = await authenticate(c, "webhooks");
  return json(publicWebhook(await getWebhook(c.params.id, key.id)));
});

export const DELETE = route<{ id: string }>(async (c) => {
  const key = await authenticate(c, "webhooks");
  await deleteWebhook(await getWebhook(c.params.id, key.id));
  return noContent();
});
