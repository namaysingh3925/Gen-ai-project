import { authenticate } from "@/lib/auth";
import { deleteJob, loadOwnedJob, serializeJob } from "@/lib/generate";
import { ApiError, json, noContent, preflight, route } from "@/lib/http";
import { DOC_LABELS } from "@/lib/prompts";
import { DOC_TYPES, type DocType } from "@/lib/types";

export const runtime = "nodejs";
export const OPTIONS = preflight;

/**
 * Fetch a document set.
 *   ?format=json (default) | markdown   -  export as JSON or raw Markdown
 *   ?type=readme|architecture|api|contributing|changelog   -  a single document (markdown format)
 *   ?download=1   -  add a Content-Disposition attachment header
 */
export const GET = route<{ id: string }>(async (c) => {
  const key = await authenticate(c, "read");
  const job = await loadOwnedJob(c.params.id, key.id);
  const q = new URL(c.req.url).searchParams;
  const format = q.get("format") ?? "json";

  if (format === "json") return json(serializeJob(job));
  if (format !== "markdown") throw new ApiError(400, "invalid_format", 'format must be "json" or "markdown".');
  if (job.status !== "completed") {
    throw new ApiError(409, "not_ready", `The document set is ${job.status}; markdown export is available once it is completed.`);
  }

  const typeParam = q.get("type");
  let body: string;
  let filename: string;
  if (typeParam) {
    if (!(DOC_TYPES as readonly string[]).includes(typeParam)) {
      throw new ApiError(400, "invalid_type", `type must be one of: ${DOC_TYPES.join(", ")}.`);
    }
    const doc = job.documents[typeParam as DocType];
    if (!doc) throw new ApiError(404, "document_not_found", `This document set has no "${typeParam}" document.`);
    body = doc.markdown;
    filename = DOC_LABELS[typeParam as DocType];
  } else {
    body = (Object.entries(job.documents) as [DocType, { markdown: string }][]).map(([, d]) => d.markdown).join("\n\n---\n\n");
    filename = `${job.repo.fullName.replace("/", "-")}-docs.md`;
  }

  const headers: Record<string, string> = { "Content-Type": "text/markdown; charset=utf-8" };
  if (q.get("download") === "1" || q.get("download") === "true") headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  return new Response(body, { status: 200, headers });
});

export const DELETE = route<{ id: string }>(async (c) => {
  const key = await authenticate(c, "generate");
  const job = await loadOwnedJob(c.params.id, key.id);
  await deleteJob(job);
  return noContent();
});
