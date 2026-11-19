/**
 * Decides which repository files are worth sending to the LLM. A repo can contain thousands of
 * files, so we rank paths (manifests, entry points, routes, docs ...) and fill a fixed budget.
 */
import { fetchRawFile, type RepoSnapshot, type TreeEntry } from "./github";

export const SKIP_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", "out", ".next", ".nuxt", "target", "__pycache__", "coverage",
  ".venv", "venv", "env", "bin", "obj", ".gradle", "pods", "third_party", "site-packages", ".cache",
  ".turbo", ".svelte-kit", "storybook-static", ".idea", ".vscode", ".git", ".husky", "bower_components",
  "migrations", "fixtures", "__snapshots__", "assets", "static", "public",
]);

const SKIP_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "avif", "bmp", "pdf", "zip", "gz", "tar", "tgz", "7z", "rar",
  "woff", "woff2", "ttf", "eot", "otf", "mp3", "mp4", "mov", "avi", "wav", "webm", "exe", "dll", "so", "dylib",
  "class", "jar", "pyc", "o", "a", "bin", "dat", "db", "sqlite", "lock", "log", "csv", "tsv", "parquet", "ipynb",
  "psd", "ai", "sketch", "fig", "wasm", "map", "snap", "pb", "onnx", "pt", "h5", "pkl",
]);

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "poetry.lock", "cargo.lock", "go.sum",
  "composer.lock", "gemfile.lock", "pipfile.lock", "mix.lock", "pubspec.lock", "packages.lock.json",
]);

const MANIFESTS = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "pipfile", "pom.xml",
  "build.gradle", "build.gradle.kts", "settings.gradle", "cargo.toml", "go.mod", "gemfile", "composer.json",
  "mix.exs", "pubspec.yaml", "deno.json", "cmakelists.txt", "makefile", "vercel.json", "netlify.toml",
  "procfile", "app.json", "manifest.json",
]);

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "rb", "php", "cs", "cpp", "cc", "c",
  "h", "hpp", "swift", "scala", "dart", "vue", "svelte", "lua", "sh", "ex", "exs", "sql", "graphql", "proto",
]);

const ENTRY = /^(main|index|app|server|cli|__main__|manage|run|start|program|cmd|lib|mod|handler)\.[a-z]+$/;
const ROUTEISH = /(^|\/)(routes?|api|controllers?|handlers?|endpoints?|views|pages|app|commands?|services?|models?|schemas?|src)(\/|$)/;
const CONFIG = /^(tsconfig|next\.config|vite\.config|webpack\.config|tailwind\.config|nuxt\.config|astro\.config|svelte\.config|jest\.config|vitest\.config|\.eslintrc|\.prettierrc|babel\.config)/;
const TESTISH = /(^|\/)(tests?|__tests__|spec|e2e|cypress)(\/|$)|\.(test|spec)\.|^test_/;

/** Higher = more informative. -1 = never send. */
export function scoreFile(path: string, size: number): number {
  const parts = path.split("/");
  const file = parts[parts.length - 1];
  const lower = file.toLowerCase();
  const dirs = parts.slice(0, -1);
  const depth = dirs.length;

  if (dirs.some((d) => SKIP_DIRS.has(d.toLowerCase()) || (d.startsWith(".") && d !== ".github"))) return -1;
  if (size === 0 || size > 200_000) return -1;
  if (LOCKFILES.has(lower)) return -1;
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  if (SKIP_EXT.has(ext)) return -1;
  if (/\.min\.(js|css)$/.test(lower)) return -1;

  if (depth === 0 && /^readme(\.|$)/.test(lower)) return 100;
  if (/^(\.env\.(example|sample|template|dist)|env\.example)$/.test(lower)) return 85;
  if (MANIFESTS.has(lower)) return depth <= 1 ? 90 - depth * 8 : 60 - depth * 3;
  if (/^docker(file|-compose)/.test(lower)) return 70 - depth * 4;
  if (/^(openapi|swagger)\.(json|ya?ml)$/.test(lower)) return 75;
  if (dirs[0] === ".github" && dirs[1] === "workflows") return 35;
  if (depth === 0 && /^license(\.|$)/.test(lower)) return 22;
  if (depth === 0 && /^(contributing|architecture|changelog)\.(md|rst)$/.test(lower)) return 30;
  if (ext === "md" || ext === "mdx" || ext === "rst") return dirs[0] === "docs" ? 32 - depth * 2 : 12 - depth;

  let s: number;
  if (ENTRY.test(lower)) s = 62 - depth * 5;
  else if (ROUTEISH.test(path) && CODE_EXT.has(ext)) s = 46 - depth * 2;
  else if (CODE_EXT.has(ext)) s = 28 - depth * 2;
  else if (CONFIG.test(lower)) s = 20 - depth;
  else return -1;

  if (TESTISH.test(path)) s -= 25;
  return Math.max(s, 1);
}

export interface Candidate {
  path: string;
  size: number;
  score: number;
}

export function selectFiles(tree: TreeEntry[], maxFiles = 26): Candidate[] {
  return tree
    .filter((e) => e.type === "blob")
    .map((e) => ({ path: e.path, size: e.size ?? 0, score: scoreFile(e.path, e.size ?? 0) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.size - b.size)
    .slice(0, maxFiles);
}

export interface LoadedFile {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

const perFileLimit = (path: string) => (/^readme/i.test(path) ? 8000 : MANIFESTS.has(path.toLowerCase()) ? 5000 : 6000);

/** Download the selected files (a few at a time) until the character budget is used up. */
export async function loadFiles(
  snap: RepoSnapshot,
  candidates: Candidate[],
  userToken: string | undefined,
  maxTotalChars = 100_000,
  concurrency = 6,
): Promise<LoadedFile[]> {
  const out: LoadedFile[] = [];
  let total = 0;
  for (let i = 0; i < candidates.length && total < maxTotalChars; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((c) => fetchRawFile(snap, c.path, userToken, perFileLimit(c.path))));
    results.forEach((r, idx) => {
      if (!r || total >= maxTotalChars) return;
      const content = r.text.length + total > maxTotalChars ? r.text.slice(0, maxTotalChars - total) : r.text;
      total += content.length;
      out.push({ path: batch[idx].path, content, bytes: batch[idx].size, truncated: r.truncated || content.length < r.text.length });
    });
  }
  return out;
}

/** Compact directory listing (dirs to depth 3, files to depth 2) for the prompt. */
export function buildTreeSummary(tree: TreeEntry[], maxEntries = 200): string {
  const lines: string[] = [];
  const sorted = [...tree].sort((a, b) => a.path.localeCompare(b.path));
  for (const e of sorted) {
    const parts = e.path.split("/");
    if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d.toLowerCase()) || (d.startsWith(".") && d !== ".github"))) continue;
    if (e.type === "tree") {
      if (SKIP_DIRS.has(parts[parts.length - 1].toLowerCase()) || parts.length > 3) continue;
      lines.push(`${e.path}/`);
    } else if (e.type === "blob") {
      if (parts.length > 3) continue;
      lines.push(e.path);
    }
  }
  if (lines.length <= maxEntries) return lines.join("\n");
  return `${lines.slice(0, maxEntries).join("\n")}\n... (${lines.length - maxEntries} more entries)`;
}
