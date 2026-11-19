/**
 * Centralised, lazily-read configuration. All secrets come from environment variables
 * (`.env.local` in development, Project Settings -> Environment Variables on Vercel).
 * Getters are used so tests can change `process.env` at runtime.
 */
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const bool = (name: string, fallback: boolean) => {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v);
};

export const env = {
  get geminiKey() {
    return process.env.GEMINI_API_KEY?.trim() ?? "";
  },
  get geminiBaseUrl() {
    return (process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  },
  get geminiModel() {
    return process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
  },
  get geminiFallbacks() {
    return (process.env.GEMINI_FALLBACK_MODELS ?? "gemini-2.5-flash,gemini-2.0-flash,gemini-flash-lite-latest")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get redisUrl() {
    return (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").trim().replace(/\/+$/, "");
  },
  get redisToken() {
    return (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "").trim();
  },
  get githubToken() {
    return process.env.GITHUB_TOKEN?.trim() ?? "";
  },
  get ratePerMinute() {
    return num("RATE_LIMIT_PER_MINUTE", 30);
  },
  get generationsPerDay() {
    return num("GENERATIONS_PER_DAY", 20);
  },
  get keyIssuePerHour() {
    return num("KEY_ISSUE_PER_HOUR", 10);
  },
  get allowPrivateWebhookTargets() {
    return bool("ALLOW_PRIVATE_WEBHOOK_TARGETS", process.env.NODE_ENV !== "production");
  },
  get publicBaseUrl() {
    const explicit = process.env.PUBLIC_BASE_URL?.trim();
    return explicit ? explicit.replace(/\/+$/, "") : "";
  },
  get onVercel() {
    return Boolean(process.env.VERCEL);
  },
};

export const APP_VERSION = "1.0.0";
