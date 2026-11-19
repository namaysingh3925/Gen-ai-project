import { authenticate } from "@/lib/auth";
import { generateInputSchema } from "@/lib/generate";
import { json, preflight, readJson, route } from "@/lib/http";
import { createSync, listSyncs, publicSync } from "@/lib/sync";

export const runtime = "nodejs";
export const OPTIONS = preflight;

const schema = generateInputSchema.omit({ async: true });

export const GET = route(async (c) => {
  const key = await authenticate(c, "webhooks");
  const syncs = await listSyncs(key.id);
  return json({ object: "list", data: syncs.map((s) => publicSync(s, c.origin)) });
});

/**
 * Subscribe a repository to auto-sync. Returns the GitHub payload URL + secret (shown once).
 * Add them in GitHub: Repo -> Settings -> Webhooks -> Add webhook (Content type: application/json, event: push).
 */
export const POST = route(async (c) => {
  const key = await authenticate(c, "webhooks");
  const body = await readJson(c.req, schema);
  const rec = await createSync(key.id, body);
  return json(
    {
      ...publicSync(rec, c.origin, true),
      setup: [
        "In GitHub open the repository -> Settings -> Webhooks -> Add webhook.",
        "Payload URL: the payloadUrl above. Content type: application/json. Secret: the secret above.",
        "Choose 'Just the push event' and save. GitHub sends a ping; this endpoint answers 200.",
      ],
    },
    201,
    { Location: `${c.origin}/api/v1/sync/${rec.id}` },
  );
});
