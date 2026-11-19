import { describe, expect, it } from "vitest";
import { parseRepoUrl } from "@/lib/github";

describe("parseRepoUrl", () => {
  it.each([
    ["https://github.com/octocat/Hello-World", "octocat", "Hello-World"],
    ["http://github.com/octocat/Hello-World/", "octocat", "Hello-World"],
    ["github.com/octocat/Hello-World", "octocat", "Hello-World"],
    ["www.github.com/octocat/Hello-World.git", "octocat", "Hello-World"],
    ["octocat/Hello-World", "octocat", "Hello-World"],
    ["git@github.com:octocat/Hello-World.git", "octocat", "Hello-World"],
    ["  https://github.com/octocat/Hello-World/issues/3  ", "octocat", "Hello-World"],
  ])("parses %s", (input, owner, name) => {
    expect(parseRepoUrl(input)).toMatchObject({ owner, name });
  });

  it("extracts the branch from /tree/ links", () => {
    expect(parseRepoUrl("https://github.com/o/r/tree/develop")).toEqual({ owner: "o", name: "r", branch: "develop" });
  });

  it.each([
    "",
    "not a url",
    "https://gitlab.com/o/r",
    "https://evil.com/github.com/o/r",
    "https://github.com.evil.com/o/r",
    "https://github.com/onlyowner",
    "https://github.com/o/..",
    "javascript:alert(1)",
    "https://github.com/o/r with space",
    "file:///etc/passwd",
  ])("rejects %j with invalid_repo_url", (input) => {
    expect(() => parseRepoUrl(input)).toThrowError(expect.objectContaining({ status: 400, code: "invalid_repo_url" }));
  });
});
