import { after } from "next/server";
import { authenticate } from "@/lib/auth";
import { createJob, generateInputSchema, runJob, serializeJob } from "@/lib/generate";
import { ApiError, json, preflight, readJson, route } from "@/lib/http";
import { assertQuotaAvailable } from "@/lib/ratelimit";
import { dispatchJobEvent } from "@/lib/webhooks";

export const runtime = "nodejs";
export const maxDuration = 60;
export const OPTIONS = preflight;

/** Background work (generation + webhook delivery) must finish before maxDuration; keep a margin. */
const FUNCTION_BUDGET_MS = 57_000;

/**
 * Generate documentation for a GitHub repository.
 *  - default (sync): waits for Gemini and returns 201 with the finished document set.
 *  - `"async": true`: returns 202 immediately; poll `GET /api/v1/docs/{id}` or subscribe to webhooks.
 */
export const POST = route(async (c) => {
  const deadline = Date.now() + FUNCTION_BUDGET_MS;
  const key = await authenticate(c, "generate");
  const input = await readJson(c.req, generateInputSchema);
  await assertQuotaAvailable(key.id);
  const userToken = c.req.headers.get("x-github-token") ?? undefined; // private repos; never stored

  const job = await createJob(input, key.id, c.origin);
  const location = `${c.origin}/api/v1/docs/${job.id}`;

  if (input.async) {
    after(async () => {
      const done = await runJob(job, userToken);
      await dispatchJobEvent(done, deadline);
    });
    return json(serializeJob(job), 202, { Location: location });
  }

  const done = await runJob(job, userToken);
  after(() => dispatchJobEvent(done, deadline));
  if (done.status === "failed" && done.error) {
    throw new ApiError(
      done.error.status ?? 500,
      done.error.code,
      done.error.message,
      { docId: done.id },
      done.error.retryAfter ? { "Retry-After": done.error.retryAfter } : {},
    );
  }
  return json(serializeJob(done), 201, { Location: location });
});
