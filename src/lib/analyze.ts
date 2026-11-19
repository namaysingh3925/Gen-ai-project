/**
 * Deterministic repository analysis: languages, tech stack, scripts, env vars and quality flags.
 * Runs without any LLM, so `/api/v1/analyze` is free and instant.
 */
import type { RepoSnapshot } from "./github";
import type { LoadedFile } from "./selector";
import type { Analysis } from "./types";

const NODE_STACK: [string, string][] = [
  ["next", "Next.js"], ["react", "React"], ["vue", "Vue"], ["nuxt", "Nuxt"], ["svelte", "Svelte"],
  ["@angular/core", "Angular"], ["astro", "Astro"], ["express", "Express"], ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"], ["koa", "Koa"], ["hono", "Hono"], ["tailwindcss", "Tailwind CSS"],
  ["prisma", "Prisma"], ["@prisma/client", "Prisma"], ["mongoose", "MongoDB (Mongoose)"], ["mongodb", "MongoDB"],
  ["sequelize", "Sequelize"], ["typeorm", "TypeORM"], ["drizzle-orm", "Drizzle ORM"],
  ["@supabase/supabase-js", "Supabase"], ["firebase", "Firebase"], ["socket.io", "Socket.IO"],
  ["graphql", "GraphQL"], ["typescript", "TypeScript"], ["vite", "Vite"], ["webpack", "Webpack"],
  ["jest", "Jest"], ["vitest", "Vitest"], ["mocha", "Mocha"], ["playwright", "Playwright"],
  ["cypress", "Cypress"], ["electron", "Electron"], ["react-native", "React Native"], ["expo", "Expo"],
  ["langchain", "LangChain"], ["openai", "OpenAI SDK"], ["@google/genai", "Google Gen AI SDK"],
  ["@google/generative-ai", "Google Generative AI SDK"], ["redis", "Redis"], ["ioredis", "Redis"],
  ["pg", "PostgreSQL"], ["mysql2", "MySQL"], ["zod", "Zod"], ["@trpc/server", "tRPC"],
];

const PY_STACK: [RegExp, string][] = [
  [/^django\b/im, "Django"], [/^flask\b/im, "Flask"], [/^fastapi\b/im, "FastAPI"], [/^streamlit\b/im, "Streamlit"],
  [/^pandas\b/im, "pandas"], [/^numpy\b/im, "NumPy"], [/^scikit-learn\b/im, "scikit-learn"],
  [/^(torch|pytorch)\b/im, "PyTorch"], [/^tensorflow\b/im, "TensorFlow"], [/^keras\b/im, "Keras"],
  [/^langchain\b/im, "LangChain"], [/^openai\b/im, "OpenAI SDK"], [/^google-generativeai\b/im, "Google Generative AI SDK"],
  [/^sqlalchemy\b/im, "SQLAlchemy"], [/^pytest\b/im, "pytest"], [/^celery\b/im, "Celery"],
  [/^opencv/im, "OpenCV"], [/^beautifulsoup4\b/im, "BeautifulSoup"], [/^pydantic\b/im, "Pydantic"],
];

const ENV_IGNORE = new Set(["NODE_ENV", "PATH", "HOME", "CI", "PWD", "USER", "SHELL", "LANG", "TZ", "PORT_UNUSED"]);

const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /os\.environ(?:\.get)?\s*[\[(]\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /os\.Getenv\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
];

function addUnique(list: string[], v: string) {
  if (!list.includes(v)) list.push(v);
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function analyzeRepo(snap: RepoSnapshot, files: LoadedFile[]): { analysis: Analysis; readme: string | null } {
  const stack: string[] = [];
  let scripts: Record<string, string> = {};
  const entryPoints: string[] = [];
  const envVars: string[] = [];

  for (const f of files) {
    const base = f.path.split("/").pop()!.toLowerCase();
    const depth = f.path.split("/").length - 1;

    if (base === "package.json" && depth <= 1) {
      const pkg = parseJson<{
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
        main?: string;
        bin?: string | Record<string, string>;
      }>(f.content);
      if (pkg) {
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [dep, label] of NODE_STACK) if (dep in deps) addUnique(stack, label);
        if (depth === 0 || !Object.keys(scripts).length) scripts = pkg.scripts ?? scripts;
        if (pkg.main) addUnique(entryPoints, pkg.main);
        if (typeof pkg.bin === "string") addUnique(entryPoints, pkg.bin);
      }
      addUnique(stack, "Node.js");
    } else if (base === "requirements.txt" || base === "pyproject.toml" || base === "pipfile") {
      addUnique(stack, "Python");
      for (const [re, label] of PY_STACK) if (re.test(f.content) || new RegExp(`["']${re.source.replace(/\^|\\b/g, "")}`, "i").test(f.content)) addUnique(stack, label);
    } else if (base === "go.mod") {
      addUnique(stack, "Go");
      if (/gin-gonic\/gin/.test(f.content)) addUnique(stack, "Gin");
      if (/labstack\/echo/.test(f.content)) addUnique(stack, "Echo");
      if (/gofiber\/fiber/.test(f.content)) addUnique(stack, "Fiber");
    } else if (base === "cargo.toml") {
      addUnique(stack, "Rust");
      for (const [dep, label] of [["actix-web", "Actix"], ["axum", "Axum"], ["tokio", "Tokio"], ["rocket", "Rocket"], ["serde", "Serde"]]) {
        if (new RegExp(`^\\s*${dep}\\b`, "m").test(f.content)) addUnique(stack, label);
      }
    } else if (base === "pom.xml" || base.startsWith("build.gradle")) {
      addUnique(stack, "Java/JVM");
      if (/spring-boot/.test(f.content)) addUnique(stack, "Spring Boot");
    } else if (base === "gemfile") {
      addUnique(stack, "Ruby");
      if (/['"]rails['"]/.test(f.content)) addUnique(stack, "Ruby on Rails");
    } else if (base === "composer.json") {
      addUnique(stack, "PHP");
      if (/laravel\/framework/.test(f.content)) addUnique(stack, "Laravel");
      if (/symfony\//.test(f.content)) addUnique(stack, "Symfony");
    } else if (/^dockerfile/.test(base)) {
      addUnique(stack, "Docker");
    } else if (/^docker-compose/.test(base)) {
      addUnique(stack, "Docker Compose");
    }

    if (/^(\.env\.(example|sample|template|dist)|env\.example)$/.test(base)) {
      for (const m of f.content.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,})\s*=/gm)) {
        if (!ENV_IGNORE.has(m[1])) addUnique(envVars, m[1]);
      }
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|vue|svelte)$/.test(base)) {
      for (const re of ENV_PATTERNS) {
        for (const m of f.content.matchAll(re)) if (!ENV_IGNORE.has(m[1])) addUnique(envVars, m[1]);
      }
    }
    if (/^(main|index|app|server|cli|__main__|manage)\.[a-z]+$/.test(base) && depth <= 2) addUnique(entryPoints, f.path);
  }

  const total = Object.values(snap.languages).reduce((a, b) => a + b, 0) || 1;
  const languages = Object.entries(snap.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, bytes]) => ({ name, percent: Math.round((bytes / total) * 1000) / 10 }));

  if (snap.meta.language && !stack.includes(snap.meta.language) && stack.length === 0) stack.push(snap.meta.language);

  const paths = snap.tree.filter((e) => e.type === "blob").map((e) => e.path);
  const lowerPaths = paths.map((p) => p.toLowerCase());
  const readmeFile = files.find((f) => /^readme(\.|$)/i.test(f.path));

  const analysis: Analysis = {
    languages,
    stack,
    scripts: Object.fromEntries(Object.entries(scripts).slice(0, 15)),
    envVars: envVars.slice(0, 40),
    entryPoints: entryPoints.slice(0, 6),
    fileCount: paths.length,
    analyzedFiles: files.map((f) => ({ path: f.path, bytes: f.bytes, truncated: f.truncated })),
    flags: {
      hasReadme: lowerPaths.some((p) => /^readme(\.|$)/.test(p)),
      hasTests: lowerPaths.some((p) => /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\./.test(p)),
      hasCI: lowerPaths.some((p) => p.startsWith(".github/workflows/") || p === ".gitlab-ci.yml" || p.startsWith(".circleci/")),
      hasDocker: lowerPaths.some((p) => /(^|\/)dockerfile/.test(p)),
      hasLicense: Boolean(snap.meta.license) || lowerPaths.some((p) => /^license(\.|$)/.test(p)),
    },
    treeTruncated: snap.truncated,
  };

  return { analysis, readme: readmeFile?.content ?? null };
}
