export const DOC_TYPES = ["readme", "architecture", "api", "contributing", "changelog"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const STYLES = ["concise", "standard", "detailed", "beginner"] as const;
export type Style = (typeof STYLES)[number];

export const ALL_SCOPES = ["generate", "read", "webhooks"] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export const WEBHOOK_EVENTS = ["doc.completed", "doc.failed", "sync.triggered", "ping"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface GenerateOptions {
  types: DocType[];
  style: Style;
  language: string;
  branch?: string;
  includeBadges: boolean;
}

export interface RepoMeta {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  defaultBranch: string;
  stars: number;
  forks: number;
  language: string | null;
  license: string | null;
  topics: string[];
  isPrivate: boolean;
  archived: boolean;
  pushedAt: string | null;
  homepage: string | null;
}

export interface Analysis {
  languages: { name: string; percent: number }[];
  stack: string[];
  scripts: Record<string, string>;
  envVars: string[];
  entryPoints: string[];
  fileCount: number;
  analyzedFiles: { path: string; bytes: number; truncated: boolean }[];
  flags: { hasReadme: boolean; hasTests: boolean; hasCI: boolean; hasDocker: boolean; hasLicense: boolean };
  treeTruncated: boolean;
}

export interface HealthCheck {
  id: string;
  label: string;
  passed: boolean;
  weight: number;
  hint: string;
}

export interface Health {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  checks: HealthCheck[];
}

export interface GeneratedDoc {
  markdown: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  generatedAt: string;
  revisions: number;
}

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface DocJob {
  object: "document_set";
  id: string;
  keyId: string;
  status: JobStatus;
  source: "api" | "sync";
  repo: {
    url: string;
    fullName: string;
    branch: string | null;
    treeSha: string | null;
    description: string | null;
    stars: number | null;
    language: string | null;
    license: string | null;
  };
  options: GenerateOptions;
  origin: string;
  progress: { step: string; completed: number; total: number };
  documents: Partial<Record<DocType, GeneratedDoc>>;
  analysis: Analysis | null;
  health: { before: Health | null; after: Health | null } | null;
  warnings: string[];
  error: { code: string; message: string; status?: number; retryAfter?: string } | null;
  cached: boolean;
  usage: { promptTokens: number; outputTokens: number; durationMs: number };
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
