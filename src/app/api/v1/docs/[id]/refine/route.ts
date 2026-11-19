import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { loadOwnedJob, refineDocument, serializeJob } from "@/lib/generate";
import { ApiError, json, preflight, readJson, route } from "@/lib/http";
import { assertQuotaAvailable } from "@/lib/ratelimit";
import { DOC_TYPES } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const OPTIONS = preflight;

const schema = z.object({
  type: z.enum(DOC_TYPES),
  instruction: z.string().trim().min(3).max(500),
});

/** Edit one generated document with a natural-language instruction ("shorten the install section"). */
export const POST = route<{ id: string }>(async (c) => {
  const key = await authenticate(c, "generate");
  const body = await readJson(c.req, schema);
  const job = await loadOwnedJob(c.params.id, key.id);
  if (job.status !== "completed") throw new ApiError(409, "not_ready", `The document set is ${job.status}; wait until it is completed.`);
  await assertQuotaAvailable(key.id);
  const updated = await refineDocument(job, body.type, body.instruction);
  return json(serializeJob(updated));
});
