import { authenticate } from "@/lib/auth";
import { json, noContent, preflight, route } from "@/lib/http";
import { deleteSync, getSync, publicSync } from "@/lib/sync";

export const runtime = "nodejs";
export const OPTIONS = preflight;

export const GET = route<{ id: string }>(async (c) => {
  const key = await authenticate(c, "webhooks");
  return json(publicSync(await getSync(c.params.id, key.id), c.origin));
});

export const DELETE = route<{ id: string }>(async (c) => {
  const key = await authenticate(c, "webhooks");
  await deleteSync(await getSync(c.params.id, key.id));
  return noContent();
});
