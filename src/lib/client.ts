/**
 * Browser-side API client. The web app is just another client of the public API: on first use it
 * mints its own API key (POST /api/v1/keys), keeps it in localStorage, and sends it as a Bearer token.
 */
import type { DocJob } from "./types";

const KEY_STORE = "reposcribe.apiKey";

/** Job as returned by the API (owner id and origin are stripped, links are added). */
export type JobView = Omit<DocJob, "keyId" | "origin"> & { links: { self: string; markdown: string } };

export interface JobSummary {
  id: string;
  status: DocJob["status"];
  repo: { fullName: string; url: string; branch: string | null };
  types: string[];
  cached: boolean;
  health: { before: number | null; after: number | null } | null;
  createdAt: string;
}

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export function getStoredKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}

export function setStoredKey(key: string | null) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* storage unavailable: key lives only for this page load */
  }
}

let memoryKey: string | null = null;

async function parse(res: Response) {
  if (res.status === 204) return undefined;
  return res.json().catch(() => null);
}

function toError(res: Response, data: { error?: { code?: string; message?: string } } | null) {
  return new ApiClientError(
    res.status,
    data?.error?.code ?? "request_failed",
    data?.error?.message ?? `Request failed (${res.status})`,
    Number(res.headers.get("retry-after")) || undefined,
  );
}

export async function issueKey(name = "Browser (web app)"): Promise<string> {
  const res = await fetch("/api/v1/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await parse(res);
  if (!res.ok) throw toError(res, data);
  memoryKey = data.apiKey;
  setStoredKey(data.apiKey);
  return data.apiKey as string;
}

/** One key-issuing request at a time: pages fire several API calls on mount, and each would otherwise mint its own key. */
let issuing: Promise<string> | null = null;

export async function ensureKey(): Promise<string> {
  const existing = getStoredKey() ?? memoryKey;
  if (existing) return existing;
  issuing ??= issueKey().finally(() => {
    issuing = null;
  });
  return issuing;
}

interface Options extends Omit<RequestInit, "body"> {
  json?: unknown;
  githubToken?: string;
  retried?: boolean;
}

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const key = await ensureKey();
  const headers = new Headers(opts.headers);
  headers.set("Authorization", `Bearer ${key}`);
  if (opts.json !== undefined) headers.set("Content-Type", "application/json");
  if (opts.githubToken?.trim()) headers.set("X-GitHub-Token", opts.githubToken.trim());

  const res = await fetch(path, {
    ...opts,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });

  // The stored key was revoked/rotated elsewhere: mint a fresh one once and retry.
  if (res.status === 401 && !opts.retried) {
    memoryKey = null;
    setStoredKey(null);
    return api<T>(path, { ...opts, retried: true });
  }
  const data = await parse(res);
  if (!res.ok) throw toError(res, data as never);
  return data as T;
}

export function describeError(e: unknown): string {
  if (e instanceof ApiClientError) {
    return e.retryAfter && e.status === 429 ? `${e.message} (retry in ~${e.retryAfter}s)` : e.message;
  }
  return "Network error - check your connection and try again.";
}

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
