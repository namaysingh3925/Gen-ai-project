/**
 * The documentation pipeline:
 *   fetch repo -> pick & read key files -> deterministic analysis -> Gemini (one call per doc type,
 *   a few in parallel) -> post-process -> score -> cache.
 * Job state is persisted after every step so clients can poll progress.
 */
import { z } from "zod";
import { analyzeRepo } from "./analyze";
import { newId, sha256 } from "./crypto";
import { generateText } from "./gemini";
import { fetchCommits, fetchRepoSnapshot, parseRepoUrl, type CommitInfo, type RepoSnapshot } from "./github";
import { scoreReadme } from "./health";
import { ApiError } from "./http";
import { buildContext, buildPrompt, buildRefinePrompt, DOC_LABELS, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompts";
import { consumeGeneration } from "./ratelimit";
import { buildTreeSummary, loadFiles, selectFiles } from "./selector";
import { kv } from "./store";
import { DOC_TYPES, STYLES, type DocJob, type DocType, type GenerateOptions } from "./types";

const JOB_TTL = 30 * 86400;
const CACHE_TTL = 7 * 86400;
const STALE_AFTER_MS = 150_000;
/** Vercel Hobby functions may run up to 60 s; stop LLM work a little before that. */
const TIME_BUDGET_MS = 54_000;
const LLM_CONCURRENCY = 3;

const jobKey = (id: string) => `job:${id}`;

/* --------------------------------- input schema --------------------------------- */

const languageSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} ()'-]*$/u, "Language may only contain letters, spaces, hyphens and parentheses.");

export const generateInputSchema = z.object({
  repoUrl: z.string().trim().min(1).max(300),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._/-]+$/, "Invalid branch name.")
    .optional(),
  types: z.array(z.enum(DOC_TYPES)).min(1).max(DOC_TYPES.length).default(["readme"]),
  style: z.enum(STYLES).default("standard"),
  language: languageSchema.default("English"),
  includeBadges: z.boolean().default(true),
  async: z.boolean().default(false),
});
export type GenerateInput = z.output<typeof generateInputSchema>;

/* ------------------------------------ helpers ------------------------------------ */

const now = () => new Date().toISOString();

async function persist(job: DocJob) {
  job.updatedAt = now();
  await kv().set(jobKey(job.id), job, JOB_TTL);
}

/** Remove a wrapping ```markdown fence if the model added one. */
export function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*)\r?\n```$/i.exec(t);
  return (m ? m[1] : t).trim();
}

export function badgeLine(meta: RepoSnapshot["meta"]): string {
  const base = `${meta.owner}/${meta.name}`;
  const b: string[] = [];
  if (meta.license) b.push(`![License](https://img.shields.io/github/license/${base})`);
  b.push(`![Stars](https://img.shields.io/github/stars/${base}?style=flat)`);
  b.push(`![Top language](https://img.shields.io/github/languages/top/${base})`);
  b.push(`![Last commit](https://img.shields.io/github/last-commit/${base})`);
  return b.join(" ");
}

export function postProcess(type: DocType, text: string, snap: RepoSnapshot, options: GenerateOptions): string {
  let md = stripFence(text);
  if (type === "readme" && options.includeBadges && !/img\.shields\.io/i.test(md)) {
    const badges = badgeLine(snap.meta);
    if (/^#\s+.+$/m.test(md)) md = md.replace(/^#\s+.+$/m, (h) => `${h}\n\n${badges}`);
    else md = `# ${snap.meta.name}\n\n${badges}\n\n${md}`;
  }
  return md;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface CachedSet {
  documents: DocJob["documents"];
  analysis: DocJob["analysis"];
  health: DocJob["health"];
}

/* ------------------------------------- jobs ------------------------------------- */

export async function createJob(input: GenerateInput, keyId: string, origin: string, source: DocJob["source"] = "api"): Promise<DocJob> {
  const ref = parseRepoUrl(input.repoUrl);
  const types = [...new Set(input.types)];
  const branch = input.branch ?? ref.branch;
  const stamp = now();
  const job: DocJob = {
    object: "document_set",
    id: newId("doc"),
    keyId,
    status: "queued",
    source,
    repo: {
      url: `https://github.com/${ref.owner}/${ref.name}`,
      fullName: `${ref.owner}/${ref.name}`,
      branch: branch ?? null,
      treeSha: null,
      description: null,
      stars: null,
      language: null,
      license: null,
    },
    options: { types, style: input.style, language: input.language, branch, includeBadges: input.includeBadges },
    origin,
    progress: { step: "Queued", completed: 0, total: 3 + types.length },
    documents: {},
    analysis: null,
    health: null,
    warnings: [],
    error: null,
    cached: false,
    usage: { promptTokens: 0, outputTokens: 0, durationMs: 0 },
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: null,
  };
  await persist(job);
  await kv().lpush(`jobs:${keyId}`, job.id, 50);
  return job;
}

/**
 * Execute a queued job to completion. Never throws: failures are recorded on the job.
 * `userToken` (private repos) lives only in memory for the duration of this call.
 */
export async function runJob(job: DocJob, userToken?: string): Promise<DocJob> {
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const total = job.progress.total;
  const step = async (label: string, completed: number) => {
    job.progress = { step: label, completed, total };
    await persist(job);
  };

  try {
    job.status = "running";
    await step("Fetching repository metadata", 0);

    const ref = parseRepoUrl(job.repo.url);
    if (job.options.branch) ref.branch = job.options.branch;
    const snap = await fetchRepoSnapshot(ref, userToken);

    job.repo = {
      ...job.repo,
      url: snap.meta.url,
      fullName: snap.meta.fullName,
      branch: snap.branch,
      treeSha: snap.treeSha,
      description: snap.meta.description,
      stars: snap.meta.stars,
      language: snap.meta.language,
      license: snap.meta.license,
    };

    // Cache: same repo content + same options => reuse (public repos only, saves Gemini quota).
    const cacheable = !snap.meta.isPrivate && !userToken;
    const cacheKey = `cache:${sha256(
      [snap.meta.fullName.toLowerCase(), snap.branch, snap.treeSha, [...job.options.types].sort().join(","), job.options.style, job.options.language.toLowerCase(), job.options.includeBadges, PROMPT_VERSION].join("|"),
    )}`;
    if (cacheable) {
      const hit = await kv().get<CachedSet>(cacheKey);
      if (hit) {
        Object.assign(job, { documents: hit.documents, analysis: hit.analysis, health: hit.health, cached: true });
        job.status = "completed";
        job.completedAt = now();
        job.usage.durationMs = Date.now() - started;
        await step("Done (served from cache - repository unchanged)", total);
        return job;
      }
    }

    await step("Reading key files", 1);
    const files = await loadFiles(snap, selectFiles(snap.tree), userToken, 80_000);
    if (files.length === 0) {
      throw new ApiError(422, "nothing_to_document", "No readable source or documentation files were found in this repository.");
    }

    await step("Analyzing project", 2);
    const { analysis, readme } = analyzeRepo(snap, files);
    job.analysis = analysis;
    job.health = { before: scoreReadme(readme), after: null };
    const treeSummary = buildTreeSummary(snap.tree);

    let commits: CommitInfo[] | undefined;
    if (job.options.types.includes("changelog")) {
      commits = await fetchCommits(snap, userToken).catch(() => undefined);
      if (!commits?.length) job.warnings.push("changelog: could not read commit history, skipping it.");
    }

    await consumeGeneration(job.keyId);
    await step("Writing documentation with Gemini", 3);

    const meta = { name: snap.meta.name, license: snap.meta.license };
    let done = 0;
    const types = job.options.types.filter((t) => t !== "changelog" || commits?.length);
    const results = await mapLimit(types, LLM_CONCURRENCY, async (type) => {
      const context = buildContext({ snap, analysis, treeSummary, files, commits: type === "changelog" ? commits : undefined });
      const res = await generateText({ system: SYSTEM_PROMPT, prompt: buildPrompt(type, job.options, context, meta), deadline });
      job.documents[type] = {
        markdown: postProcess(type, res.text, snap, job.options),
        model: res.model,
        promptTokens: res.promptTokens,
        outputTokens: res.outputTokens,
        generatedAt: now(),
        revisions: 0,
      };
      job.usage.promptTokens += res.promptTokens;
      job.usage.outputTokens += res.outputTokens;
      done++;
      await step(`Generated ${DOC_LABELS[type]}`, 3 + done);
    });

    const failures = results.flatMap((r, i) => (r.status === "rejected" ? [{ type: types[i], reason: r.reason }] : []));
    for (const f of failures) {
      const msg = f.reason instanceof ApiError ? f.reason.message : "unexpected error";
      job.warnings.push(`${f.type}: ${msg}`);
    }
    if (Object.keys(job.documents).length === 0) {
      throw failures[0]?.reason ?? new ApiError(502, "generation_failed", "No documents could be generated.");
    }

    const readmeDoc = job.documents.readme;
    job.health = { before: job.health.before, after: readmeDoc ? scoreReadme(readmeDoc.markdown) : null };

    if (cacheable && failures.length === 0 && job.warnings.length === 0) {
      await kv().set(cacheKey, { documents: job.documents, analysis: job.analysis, health: job.health } satisfies CachedSet, CACHE_TTL);
    }

    job.status = "completed";
    job.completedAt = now();
    job.usage.durationMs = Date.now() - started;
    await step("Done", total);
  } catch (e) {
    job.status = "failed";
    job.completedAt = now();
    job.usage.durationMs = Date.now() - started;
    if (e instanceof ApiError) {
      job.error = { code: e.code, message: e.message, status: e.status, retryAfter: e.headers["Retry-After"] };
    } else {
      console.error(`[job ${job.id}] failed`, e instanceof Error ? e.stack : e);
      job.error = { code: "internal_error", message: "An unexpected error occurred while generating documentation." };
    }
    await persist(job).catch(() => {});
  }
  return job;
}

/** Load a job; jobs stuck in progress (e.g. the serverless function was cut off) are failed lazily. */
export async function getJob(id: string): Promise<DocJob | null> {
  const job = await kv().get<DocJob>(jobKey(id));
  if (!job) return null;
  if ((job.status === "queued" || job.status === "running") && Date.now() - Date.parse(job.updatedAt) > STALE_AFTER_MS) {
    job.status = "failed";
    job.error = { code: "timeout", message: "The job did not finish in time. Please retry." };
    job.completedAt = now();
    await persist(job);
  }
  return job;
}

/** Owned jobs only. Unknown and foreign ids are both 404 so ids cannot be probed. */
export async function loadOwnedJob(id: string, keyId: string): Promise<DocJob> {
  const job = await getJob(id);
  if (!job || job.keyId !== keyId) throw new ApiError(404, "document_not_found", "No such document set.");
  return job;
}

export async function deleteJob(job: DocJob) {
  await kv().del(jobKey(job.id));
}

export async function listJobs(keyId: string, limit = 20): Promise<DocJob[]> {
  const ids = await kv().lrange<string>(`jobs:${keyId}`, 0, Math.min(limit, 50) - 1);
  const jobs = await Promise.all(ids.map((id) => getJob(id)));
  return jobs.filter((j): j is DocJob => j !== null && j.keyId === keyId);
}

/** Public JSON shape of a job (internal owner id and origin are never exposed). */
export function serializeJob(job: DocJob) {
  const { keyId: _keyId, origin, ...rest } = job;
  return {
    ...rest,
    links: { self: `${origin}/api/v1/docs/${job.id}`, markdown: `${origin}/api/v1/docs/${job.id}?format=markdown` },
  };
}

export function summarizeJob(job: DocJob) {
  return {
    id: job.id,
    status: job.status,
    repo: { fullName: job.repo.fullName, url: job.repo.url, branch: job.repo.branch },
    types: job.options.types,
    cached: job.cached,
    health: job.health ? { before: job.health.before?.score ?? null, after: job.health.after?.score ?? null } : null,
    source: job.source,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}

/** Ask Gemini to edit one generated document according to a natural-language instruction. */
export async function refineDocument(job: DocJob, type: DocType, instruction: string): Promise<DocJob> {
  const doc = job.documents[type];
  if (!doc) throw new ApiError(404, "document_not_found", `This document set has no "${type}" document.`);
  await consumeGeneration(job.keyId);
  const res = await generateText({
    system: SYSTEM_PROMPT,
    prompt: buildRefinePrompt(type, doc.markdown, instruction, job.repo.fullName),
    deadline: Date.now() + TIME_BUDGET_MS,
  });
  const markdown = stripFence(res.text);
  job.documents[type] = {
    ...doc,
    markdown,
    model: res.model,
    generatedAt: now(),
    revisions: doc.revisions + 1,
    promptTokens: doc.promptTokens + res.promptTokens,
    outputTokens: doc.outputTokens + res.outputTokens,
  };
  job.usage.promptTokens += res.promptTokens;
  job.usage.outputTokens += res.outputTokens;
  if (type === "readme") job.health = { before: job.health?.before ?? null, after: scoreReadme(markdown) };
  await persist(job);
  return job;
}
