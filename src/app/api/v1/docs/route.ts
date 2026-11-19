import { authenticate } from "@/lib/auth";
import { listJobs, summarizeJob } from "@/lib/generate";
import { json, preflight, route } from "@/lib/http";

export const runtime = "nodejs";
export const OPTIONS = preflight;

/** List the calling key's document sets, newest first (`?limit=1..50`). */
export const GET = route(async (c) => {
  const key = await authenticate(c, "read");
  const limit = Math.min(50, Math.max(1, Number(new URL(c.req.url).searchParams.get("limit")) || 20));
  const jobs = await listJobs(key.id, limit);
  return json({ object: "list", data: jobs.map(summarizeJob) });
});
