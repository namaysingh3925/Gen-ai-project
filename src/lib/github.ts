/**
 * Minimal GitHub client built on `fetch`. Only ever talks to api.github.com and
 * raw.githubusercontent.com (fixed hosts) so user input can never redirect requests elsewhere.
 * A caller-supplied token is used for that request only: it is never stored or logged.
 */
import { env } from "./env";
import { ApiError } from "./http";
import type { RepoMeta } from "./types";

const GH_API = "https://api.github.com";
const GH_RAW = "https://raw.githubusercontent.com";

export interface RepoRef {
  owner: string;
  name: string;
  branch?: string;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
}

export interface RepoSnapshot {
  meta: RepoMeta;
  branch: string;
  treeSha: string;
  tree: TreeEntry[];
  truncated: boolean;
  languages: Record<string, number>;
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

const invalidUrl = () =>
  new ApiError(400, "invalid_repo_url", "Provide a GitHub repository like https://github.com/owner/repo or owner/repo.");

/** Accepts https URLs, `github.com/o/r`, `o/r`, `git@github.com:o/r.git` and `/tree/<branch>` links. */
export function parseRepoUrl(input: string): RepoRef {
  const raw = (input ?? "").trim();
  if (!raw || raw.length > 300) throw invalidUrl();

  let owner: string | undefined;
  let name: string | undefined;
  let branch: string | undefined;

  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(raw);
  if (ssh) {
    [, owner, name] = ssh;
  } else if (!raw.includes("://") && /^[\w.-]+\/[\w.-]+$/.test(raw)) {
    [owner, name] = raw.split("/");
  } else {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw invalidUrl();
    }
    if (!["github.com", "www.github.com"].includes(u.hostname.toLowerCase())) throw invalidUrl();
    const parts = u.pathname.split("/").filter(Boolean);
    owner = parts[0];
    name = parts[1];
    if (parts[2] === "tree" && parts[3]) {
      try {
        branch = decodeURIComponent(parts[3]);
      } catch {
        throw invalidUrl();
      }
    }
  }

  if (name) name = name.replace(/\.git$/i, "");
  if (!owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name) || name === "." || name === "..") throw invalidUrl();
  return { owner, name, branch };
}

function ghHeaders(token?: string, accept = "application/vnd.github+json"): HeadersInit {
  const h: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "RepoScribe/1.0",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghGet<T>(path: string, token: string | undefined, notFoundCode = "repo_not_found"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${GH_API}${path}`, { headers: ghHeaders(token), cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ApiError(502, "github_unreachable", "Could not reach the GitHub API. Try again shortly.");
  }
  if (res.ok) return (await res.json()) as T;

  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) || Math.floor(Date.now() / 1000) + 60;
    throw new ApiError(
      429,
      "github_rate_limited",
      "The GitHub API rate limit was reached. Supply your own GitHub token (X-GitHub-Token header) or retry later.",
      { resetAt: reset },
      { "Retry-After": String(Math.max(1, reset - Math.floor(Date.now() / 1000))) },
    );
  }
  if (res.status === 401) {
    throw new ApiError(400, "invalid_github_token", "GitHub rejected the supplied GitHub token.");
  }
  if (res.status === 404) {
    throw new ApiError(
      404,
      notFoundCode,
      notFoundCode === "branch_not_found"
        ? "That branch does not exist in the repository."
        : "Repository not found, or it is private. For private repositories supply a GitHub token (X-GitHub-Token header).",
    );
  }
  if (res.status === 409) {
    throw new ApiError(422, "empty_repository", "The repository is empty - there is nothing to document.");
  }
  if (res.status === 403) {
    throw new ApiError(403, "github_forbidden", "GitHub denied access to this repository.");
  }
  throw new ApiError(502, "github_error", `GitHub returned an unexpected status (${res.status}).`);
}

interface RawRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  license: { spdx_id: string | null; name: string } | null;
  topics?: string[];
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
  homepage: string | null;
  owner: { login: string };
}

/**
 * Snapshot a repository: metadata, full file tree and language breakdown.
 * `userToken` (per-request, never stored) enables private repositories. The shared server token is
 * only ever used for public repositories - a private repo without a user token is refused.
 */
export async function fetchRepoSnapshot(ref: RepoRef, userToken?: string): Promise<RepoSnapshot> {
  const token = userToken?.trim() || env.githubToken || undefined;
  const raw = await ghGet<RawRepo>(`/repos/${ref.owner}/${ref.name}`, token);

  if (raw.private && !userToken?.trim()) {
    throw new ApiError(
      403,
      "private_repo_requires_token",
      "This repository is private. Supply your own GitHub token in the X-GitHub-Token header to document it.",
    );
  }

  const meta: RepoMeta = {
    owner: raw.owner.login,
    name: raw.name,
    fullName: raw.full_name,
    url: raw.html_url,
    description: raw.description,
    defaultBranch: raw.default_branch,
    stars: raw.stargazers_count,
    forks: raw.forks_count,
    language: raw.language,
    license: raw.license?.spdx_id && raw.license.spdx_id !== "NOASSERTION" ? raw.license.spdx_id : raw.license?.name ?? null,
    topics: raw.topics ?? [],
    isPrivate: raw.private,
    archived: raw.archived,
    pushedAt: raw.pushed_at,
    homepage: raw.homepage || null,
  };

  const branch = ref.branch ?? meta.defaultBranch;
  const [tree, languages] = await Promise.all([
    ghGet<{ sha: string; tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${meta.owner}/${meta.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      token,
      "branch_not_found",
    ),
    ghGet<Record<string, number>>(`/repos/${meta.owner}/${meta.name}/languages`, token).catch(() => ({}) as Record<string, number>),
  ]);

  return { meta, branch, treeSha: tree.sha, tree: tree.tree ?? [], truncated: Boolean(tree.truncated), languages };
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Fetch one file as text via raw.githubusercontent.com. Returns null for binary/missing/huge files. */
export async function fetchRawFile(
  snap: RepoSnapshot,
  path: string,
  userToken: string | undefined,
  maxChars: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const token = userToken?.trim() || env.githubToken || undefined;
  const url = `${GH_RAW}/${snap.meta.owner}/${snap.meta.name}/${encodePath(snap.branch)}/${encodePath(path)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "RepoScribe/1.0", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const len = Number(res.headers.get("content-length"));
  if (len && len > 500_000) return null;
  const text = await res.text();
  if (text.slice(0, 2000).includes("\u0000")) return null; // binary
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
  return { text, truncated: false };
}

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
}

export async function fetchCommits(snap: RepoSnapshot, userToken: string | undefined, count = 60): Promise<CommitInfo[]> {
  const token = userToken?.trim() || env.githubToken || undefined;
  const raw = await ghGet<{ sha: string; commit: { message: string; author: { date: string } | null } }[]>(
    `/repos/${snap.meta.owner}/${snap.meta.name}/commits?sha=${encodeURIComponent(snap.branch)}&per_page=${count}`,
    token,
    "branch_not_found",
  );
  return raw.map((c) => ({
    sha: c.sha.slice(0, 7),
    message: c.commit.message.split("\n")[0].slice(0, 200),
    date: c.commit.author?.date?.slice(0, 10) ?? "",
  }));
}
