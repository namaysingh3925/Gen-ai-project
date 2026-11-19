import { describe, expect, it } from "vitest";
import { scoreReadme } from "@/lib/health";
import { buildTreeSummary, scoreFile, selectFiles } from "@/lib/selector";
import type { TreeEntry } from "@/lib/github";

describe("scoreFile", () => {
  it("ranks README and manifests above ordinary source", () => {
    const readme = scoreFile("README.md", 2000);
    const manifest = scoreFile("package.json", 900);
    const entry = scoreFile("src/index.ts", 500);
    const util = scoreFile("src/utils/format.ts", 500);
    expect(readme).toBeGreaterThan(manifest);
    expect(manifest).toBeGreaterThan(entry);
    expect(entry).toBeGreaterThan(util);
  });

  it.each([
    "node_modules/react/index.js",
    "dist/bundle.js",
    ".next/server/app.js",
    "assets/logo.png",
    "package-lock.json",
    "yarn.lock",
    "vendor/lib/a.php",
    "src/app.min.js",
    "docs/diagram.svg",
    ".git/config",
    "data/dump.csv",
  ])("never sends %s", (p) => expect(scoreFile(p, 1000)).toBe(-1));

  it("skips empty and very large files", () => {
    expect(scoreFile("src/a.ts", 0)).toBe(-1);
    expect(scoreFile("src/a.ts", 300_000)).toBe(-1);
  });

  it("de-prioritises tests", () => {
    expect(scoreFile("src/a.test.ts", 500)).toBeLessThan(scoreFile("src/a.ts", 500));
  });
});

describe("selectFiles / buildTreeSummary", () => {
  const tree: TreeEntry[] = [
    { path: "README.md", type: "blob", size: 100, sha: "1" },
    { path: "package.json", type: "blob", size: 100, sha: "2" },
    { path: "src", type: "tree", sha: "3" },
    { path: "src/index.ts", type: "blob", size: 100, sha: "4" },
    { path: "node_modules", type: "tree", sha: "5" },
    { path: "node_modules/x/index.js", type: "blob", size: 100, sha: "6" },
    { path: "logo.png", type: "blob", size: 100, sha: "7" },
  ];

  it("keeps useful files, honours the limit and drops junk", () => {
    const picked = selectFiles(tree, 2).map((c) => c.path);
    expect(picked).toEqual(["README.md", "package.json"]);
    expect(selectFiles(tree).map((c) => c.path)).not.toContain("node_modules/x/index.js");
  });

  it("summarises the tree without excluded directories", () => {
    const s = buildTreeSummary(tree);
    expect(s).toContain("src/");
    expect(s).toContain("src/index.ts");
    expect(s).not.toContain("node_modules");
  });
});

describe("scoreReadme", () => {
  it("scores a missing README as 0 / F", () => {
    const h = scoreReadme(null);
    expect(h.score).toBe(0);
    expect(h.grade).toBe("F");
  });

  it("scores a thorough README highly and lists nothing critical missing", () => {
    const md = `# Project\n\n![badge](https://img.shields.io/badge/a-b-green)\n\nA useful tool that does many things for many developers, with plenty of explanation so the description check passes comfortably.\n\n## Features\n- one\n\n## Requirements\nNode 20\n\n## Installation\n\`\`\`bash\nnpm install\n\`\`\`\n\n## Usage\n\`\`\`bash\nnpm start\n\`\`\`\n\n## Configuration\nSet the .env file.\n\n## Project structure\nsrc/\n\n## Contributing\nPRs welcome.\n\n## License\nMIT\n\n${"More detail. ".repeat(40)}`;
    const h = scoreReadme(md);
    expect(h.score).toBeGreaterThanOrEqual(90);
    expect(h.grade).toBe("A");
  });

  it("score equals the sum of passed weights and weights total 100", () => {
    const h = scoreReadme("# Tiny\n\nhello");
    expect(h.checks.reduce((s, c) => s + c.weight, 0)).toBe(100);
    expect(h.score).toBe(h.checks.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0));
    expect(h.score).toBeLessThan(35);
  });
});
