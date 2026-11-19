import { z } from "zod";
import { analyzeRepo } from "@/lib/analyze";
import { authenticate } from "@/lib/auth";
import { fetchRepoSnapshot, parseRepoUrl } from "@/lib/github";
import { scoreReadme } from "@/lib/health";
import { json, preflight, readJson, route } from "@/lib/http";
import { loadFiles, selectFiles } from "@/lib/selector";

export const runtime = "nodejs";
export const maxDuration = 30;
export const OPTIONS = preflight;

const schema = z.object({
  repoUrl: z.string().trim().min(1).max(300),
  branch: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/, "Invalid branch name.").optional(),
});

/** Deterministic analysis (stack, scripts, env vars, README health). No LLM call, no quota used. */
export const POST = route(async (c) => {
  await authenticate(c, "generate");
  const body = await readJson(c.req, schema);
  const userToken = c.req.headers.get("x-github-token") ?? undefined;

  const ref = parseRepoUrl(body.repoUrl);
  if (body.branch) ref.branch = body.branch;
  const snap = await fetchRepoSnapshot(ref, userToken);
  const files = await loadFiles(snap, selectFiles(snap.tree), userToken, 60_000);
  const { analysis, readme } = analyzeRepo(snap, files);

  return json({
    object: "analysis",
    repo: { ...snap.meta, branch: snap.branch, treeSha: snap.treeSha },
    analysis,
    health: { readme: scoreReadme(readme) },
  });
});
