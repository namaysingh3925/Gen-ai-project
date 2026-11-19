import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRepoSnapshot } from "@/lib/github";

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const repo = {
  name: "r", full_name: "o/r", html_url: "https://github.com/o/r", description: null, default_branch: "main",
  stargazers_count: 1, forks_count: 0, language: null, license: null, private: false, archived: false,
  pushed_at: null, homepage: null, owner: { login: "o" },
};

function stub(routes: { repo?: Response; tree?: Response }) {
  const seen: { url: string; auth: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/languages")) return reply(200, {});
      if (url.includes("/git/trees/")) return routes.tree ?? reply(200, { sha: "t", tree: [], truncated: false });
      return routes.repo ?? reply(200, repo);
    }),
  );
  return seen;
}

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
});
afterEach(() => vi.unstubAllGlobals());

describe("GitHub error mapping", () => {
  it("maps an exhausted rate limit to 429 github_rate_limited with Retry-After", async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    stub({ repo: reply(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }) });
    const err = await fetchRepoSnapshot({ owner: "o", name: "r" }).catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: "github_rate_limited", details: { resetAt: reset } });
    expect(Number(err.headers["Retry-After"])).toBeGreaterThan(100);
  });

  it("maps 404 / 401 / 409 / bad branch to precise client errors", async () => {
    stub({ repo: reply(404, {}) });
    await expect(fetchRepoSnapshot({ owner: "o", name: "r" })).rejects.toMatchObject({ status: 404, code: "repo_not_found" });

    stub({ repo: reply(401, {}) });
    await expect(fetchRepoSnapshot({ owner: "o", name: "r" }, "ghp_bad")).rejects.toMatchObject({ status: 400, code: "invalid_github_token" });

    stub({ tree: reply(409, { message: "Git Repository is empty." }) });
    await expect(fetchRepoSnapshot({ owner: "o", name: "r" })).rejects.toMatchObject({ status: 422, code: "empty_repository" });

    stub({ tree: reply(404, {}) });
    await expect(fetchRepoSnapshot({ owner: "o", name: "r", branch: "nope" })).rejects.toMatchObject({ status: 404, code: "branch_not_found" });
  });

  it("maps network failure and unexpected statuses to 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(fetchRepoSnapshot({ owner: "o", name: "r" })).rejects.toMatchObject({ status: 502, code: "github_unreachable" });
    stub({ repo: reply(500, {}) });
    await expect(fetchRepoSnapshot({ owner: "o", name: "r" })).rejects.toMatchObject({ status: 502, code: "github_error" });
  });

  it("only ever calls GitHub hosts, with the caller's token only when provided", async () => {
    const seen = stub({});
    await fetchRepoSnapshot({ owner: "o", name: "r" });
    expect(seen.every((s) => s.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(seen.every((s) => s.auth === null)).toBe(true);
    const seen2 = stub({});
    await fetchRepoSnapshot({ owner: "o", name: "r" }, "ghp_user");
    expect(seen2.every((s) => s.auth === "Bearer ghp_user")).toBe(true);
  });

  it("never lets the shared server token read a private repository", async () => {
    process.env.GITHUB_TOKEN = "ghp_server_shared";
    stub({ repo: reply(200, { ...repo, private: true }) });
    await expect(fetchRepoSnapshot({ owner: "o", name: "r" })).rejects.toMatchObject({ status: 403, code: "private_repo_requires_token" });
    // ...but the caller's own token is accepted for it
    stub({ repo: reply(200, { ...repo, private: true }) });
    await expect(fetchRepoSnapshot({ owner: "o", name: "r" }, "ghp_user")).resolves.toMatchObject({ meta: { isPrivate: true } });
  });
});
