import { after } from "next/server";
import { json, preflight, route } from "@/lib/http";
import { runJob } from "@/lib/generate";
import { processGithubDelivery } from "@/lib/sync";
import { dispatch, dispatchJobEvent } from "@/lib/webhooks";

export const runtime = "nodejs";
export const maxDuration = 60;
export const OPTIONS = preflight;

/**
 * INCOMING webhook for GitHub `push` events. Not API-key authenticated (GitHub cannot send one);
 * instead the unguessable URL token selects the subscription and the HMAC signature
 * (X-Hub-Signature-256) proves the request really came from GitHub with our shared secret.
 */
export const POST = route<{ token: string }>(async (c) => {
  const raw = await c.req.text();
  const result = await processGithubDelivery(c.params.token, raw, c.req.headers, c.origin);

  if (result.job && result.sync) {
    const { job, sync } = result;
    after(async () => {
      await dispatch(sync.keyId, "sync.triggered", { syncId: sync.id, repo: sync.fullName, docId: job.id, triggerCount: sync.triggerCount });
      const done = await runJob(job);
      await dispatchJobEvent(done);
    });
  }
  return json(result.body, result.status);
});
