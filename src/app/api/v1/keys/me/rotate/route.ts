import { authenticate, publicKey, rotateKey } from "@/lib/auth";
import { json, preflight, route } from "@/lib/http";

export const runtime = "nodejs";
export const OPTIONS = preflight;

/** Issue a new secret for the calling key. The old secret stops working immediately. */
export const POST = route(async (c) => {
  const key = await authenticate(c);
  const { record, apiKey } = await rotateKey(key);
  return json({ ...publicKey(record), apiKey, warning: "Store this key now - it will not be shown again. The previous key no longer works." });
});
