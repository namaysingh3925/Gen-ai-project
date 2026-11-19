/**
 * OpenAPI 3.1 description of the public API. Served at /api/v1/openapi.json and rendered by /docs.
 * Keep it in sync with the route handlers under src/app/api/v1.
 */
import { APP_VERSION, env } from "./env";
import { ALL_SCOPES, DOC_TYPES, STYLES, WEBHOOK_EVENTS } from "./types";

type Json = Record<string, unknown>;

const ref = (n: string): Json => ({ $ref: `#/components/schemas/${n}` });
const body = (schema: Json, example?: unknown): Json => ({
  required: true,
  content: { "application/json": { schema, ...(example !== undefined ? { example } : {}) } },
});
const ok = (description: string, schema: Json): Json => ({ description, content: { "application/json": { schema } } });

const errorText: Record<number, string> = {
  400: "Malformed request (invalid JSON, invalid repository URL, bad query parameter).",
  401: "Missing, malformed, unknown or revoked API key.",
  403: "The key lacks the required scope, or the repository is private and no GitHub token was supplied.",
  404: "Resource not found (or not owned by this API key).",
  409: "Conflict with the current state (limit reached, document not ready).",
  413: "Request body larger than 1 MB.",
  422: "Validation error - see `error.details`.",
  429: "Rate limited or daily quota exhausted. Honour the `Retry-After` header.",
  502: "Upstream failure (GitHub or Gemini).",
  503: "Service not configured or temporarily unavailable.",
};
const errs = (...codes: number[]): Json =>
  Object.fromEntries(codes.map((c) => [String(c), { description: errorText[c], content: { "application/json": { schema: ref("Error") } } }]));

const idParam = (name: string, description: string): Json => ({ name, in: "path", required: true, description, schema: { type: "string" } });
const githubTokenHeader: Json = {
  name: "X-GitHub-Token",
  in: "header",
  required: false,
  description: "Optional GitHub token for PRIVATE repositories. Used for this request only - never stored or logged.",
  schema: { type: "string" },
};

const docExample = {
  object: "document_set",
  id: "doc_Zk3kQ1x8aB7n",
  status: "completed",
  source: "api",
  repo: { fullName: "octocat/Hello-World", url: "https://github.com/octocat/Hello-World", branch: "master" },
  options: { types: ["readme"], style: "standard", language: "English", includeBadges: true },
  documents: { readme: { markdown: "# Hello-World\n...", model: "gemini-flash-latest", revisions: 0 } },
  health: { before: { score: 18, grade: "F" }, after: { score: 92, grade: "A" } },
  cached: false,
};

export function buildOpenApi(origin: string): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "RepoScribe API",
      version: APP_VERSION,
      summary: "GitHub Repository Documentation Generator powered by Gemini.",
      description: [
        "Generate READMEs, architecture docs, API references, contributing guides and changelogs from any GitHub repository.",
        "",
        "## Authentication",
        "Create a key with `POST /api/v1/keys`, then send it on every request as `Authorization: Bearer rsk_...` (or `X-API-Key`).",
        `Keys have scopes (${ALL_SCOPES.join(", ")}), are rate limited (${env.ratePerMinute} requests/minute, ${env.generationsPerDay} generations/day by default), and can be rotated or revoked.`,
        "",
        "## Errors",
        'Every error uses the same envelope: `{ "error": { "code": "...", "message": "...", "details": ... }, "requestId": "req_..." }` with a meaningful HTTP status. Every response carries `X-Request-Id`.',
        "",
        "## Webhooks",
        "Register an HTTPS endpoint with `POST /api/v1/webhooks` to be notified when documents finish. Deliveries are JSON, signed with HMAC-SHA256 (`X-RepoScribe-Signature: v1=<hex>` over `<timestamp>.<raw body>`, key = your `whsec_` secret), and retried on 5xx/429/network errors.",
        "Verify with: `hex(hmac_sha256(secret, X-RepoScribe-Timestamp + '.' + rawBody)) == signature` and reject timestamps older than 5 minutes.",
        "",
        "## Auto-sync",
        "`POST /api/v1/sync` returns a payload URL + secret to paste into a GitHub repository webhook (push event). Each push regenerates the docs.",
      ].join("\n"),
    },
    servers: [{ url: origin }],
    security: [{ ApiKey: [] }],
    tags: [
      { name: "Keys", description: "API key management" },
      { name: "Documentation", description: "Generate and export documentation" },
      { name: "Webhooks", description: "Outbound event notifications" },
      { name: "Auto-sync", description: "Regenerate docs on every GitHub push" },
      { name: "System", description: "Health and spec" },
    ],
    paths: {
      "/api/v1/health": {
        get: {
          tags: ["System"],
          summary: "Health check",
          security: [],
          parameters: [
            {
              name: "deep",
              in: "query",
              required: false,
              description: "`1` also verifies the Gemini key and model with a free metadata call (cached 60 s); `checks.llm` becomes ok / invalid_key / model_not_found / unreachable.",
              schema: { enum: ["0", "1"] },
            },
          ],
          responses: {
            "200": ok("Service is healthy", ref("Health")),
            "503": ok("Degraded (store or Gemini key not configured)", ref("Health")),
          },
        },
      },
      "/api/v1/keys": {
        post: {
          tags: ["Keys"],
          summary: "Create an API key",
          description: "Public, self-service. Limited per client IP. The plaintext key is returned once - store it.",
          security: [],
          requestBody: body(
            { type: "object", properties: { name: { type: "string", maxLength: 60 }, scopes: { type: "array", items: { enum: [...ALL_SCOPES] } } } },
            { name: "CI pipeline", scopes: ["generate", "read"] },
          ),
          responses: { "201": ok("Key created", ref("ApiKeyCreated")), ...errs(422, 429) },
        },
      },
      "/api/v1/keys/me": {
        get: { tags: ["Keys"], summary: "Inspect the calling key (scopes, limits, usage)", responses: { "200": ok("Key info", ref("ApiKeyInfo")), ...errs(401, 429) } },
        delete: { tags: ["Keys"], summary: "Revoke the calling key", responses: { "204": { description: "Revoked" }, ...errs(401) } },
      },
      "/api/v1/keys/me/rotate": {
        post: { tags: ["Keys"], summary: "Rotate the calling key's secret", responses: { "200": ok("New key (old one is dead)", ref("ApiKeyCreated")), ...errs(401) } },
      },
      "/api/v1/analyze": {
        post: {
          tags: ["Documentation"],
          summary: "Analyze a repository (no LLM, no quota)",
          description: "Detects languages, tech stack, scripts, env vars and scores the existing README (0-100).",
          parameters: [githubTokenHeader],
          requestBody: body(ref("AnalyzeRequest"), { repoUrl: "https://github.com/octocat/Hello-World" }),
          responses: { "200": ok("Analysis", ref("AnalysisResponse")), ...errs(400, 401, 403, 404, 422, 429, 502) },
        },
      },
      "/api/v1/generate": {
        post: {
          tags: ["Documentation"],
          summary: "Generate documentation for a repository",
          description:
            "Synchronous by default (returns 201 with the finished documents, up to ~60 s). With `\"async\": true` it returns 202 immediately; poll `GET /api/v1/docs/{id}` or subscribe to the `doc.completed` webhook. Results for an unchanged public repository are served from cache without using Gemini quota.",
          parameters: [githubTokenHeader],
          requestBody: body(ref("GenerateRequest"), {
            repoUrl: "https://github.com/octocat/Hello-World",
            types: ["readme", "architecture"],
            style: "standard",
            language: "English",
            async: false,
          }),
          responses: {
            "201": { description: "Documents generated", headers: { Location: { schema: { type: "string" } } }, content: { "application/json": { schema: ref("DocumentSet"), example: docExample } } },
            "202": { description: "Accepted - generation continues in the background", headers: { Location: { schema: { type: "string" } } }, content: { "application/json": { schema: ref("DocumentSet") } } },
            ...errs(400, 401, 403, 404, 422, 429, 502, 503),
          },
        },
      },
      "/api/v1/docs": {
        get: {
          tags: ["Documentation"],
          summary: "List your document sets",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } }],
          responses: { "200": ok("List", { type: "object", properties: { object: { const: "list" }, data: { type: "array", items: ref("DocumentSetSummary") } } }), ...errs(401, 403, 429) },
        },
      },
      "/api/v1/docs/{id}": {
        get: {
          tags: ["Documentation"],
          summary: "Get / export a document set",
          description: "`format=json` (default) returns the full object; `format=markdown` exports raw Markdown (optionally one `type`). Add `download=1` for an attachment.",
          parameters: [
            idParam("id", "Document set id (doc_...)"),
            { name: "format", in: "query", schema: { enum: ["json", "markdown"], default: "json" } },
            { name: "type", in: "query", description: "Single document to export (markdown format).", schema: { enum: [...DOC_TYPES] } },
            { name: "download", in: "query", schema: { enum: ["0", "1"] } },
          ],
          responses: {
            "200": { description: "The document set", content: { "application/json": { schema: ref("DocumentSet") }, "text/markdown": { schema: { type: "string" } } } },
            ...errs(400, 401, 403, 404, 409, 429),
          },
        },
        delete: { tags: ["Documentation"], summary: "Delete a document set", parameters: [idParam("id", "Document set id")], responses: { "204": { description: "Deleted" }, ...errs(401, 403, 404) } },
      },
      "/api/v1/docs/{id}/refine": {
        post: {
          tags: ["Documentation"],
          summary: "Refine one document with a natural-language instruction",
          description: "Counts as one generation against the daily quota.",
          parameters: [idParam("id", "Document set id")],
          requestBody: body(ref("RefineRequest"), { type: "readme", instruction: "Make the installation section shorter and add a troubleshooting tip." }),
          responses: { "200": ok("Updated document set", ref("DocumentSet")), ...errs(401, 403, 404, 409, 422, 429, 502) },
        },
      },
      "/api/v1/webhooks": {
        get: { tags: ["Webhooks"], summary: "List webhooks", responses: { "200": ok("List", { type: "object", properties: { object: { const: "list" }, data: { type: "array", items: ref("Webhook") } } }), ...errs(401, 403) } },
        post: {
          tags: ["Webhooks"],
          summary: "Register a webhook",
          description: "HTTPS only; private/loopback targets are rejected (SSRF guard). The signing `secret` is returned once.",
          requestBody: body(ref("WebhookCreateRequest"), { url: "https://example.com/hooks/reposcribe", events: ["doc.completed", "doc.failed"] }),
          responses: { "201": ok("Webhook created", ref("WebhookCreated")), ...errs(401, 403, 409, 422) },
        },
      },
      "/api/v1/webhooks/{id}": {
        get: { tags: ["Webhooks"], summary: "Get a webhook", parameters: [idParam("id", "Webhook id (wh_...)")], responses: { "200": ok("Webhook", ref("Webhook")), ...errs(401, 403, 404) } },
        delete: { tags: ["Webhooks"], summary: "Delete a webhook", parameters: [idParam("id", "Webhook id")], responses: { "204": { description: "Deleted" }, ...errs(401, 403, 404) } },
      },
      "/api/v1/webhooks/{id}/test": {
        post: { tags: ["Webhooks"], summary: "Send a signed test `ping` now", parameters: [idParam("id", "Webhook id")], responses: { "200": ok("Delivery result", ref("Delivery")), ...errs(401, 403, 404) } },
      },
      "/api/v1/webhooks/{id}/deliveries": {
        get: { tags: ["Webhooks"], summary: "Recent delivery attempts", parameters: [idParam("id", "Webhook id")], responses: { "200": ok("List", { type: "object", properties: { object: { const: "list" }, data: { type: "array", items: ref("Delivery") } } }), ...errs(401, 403, 404) } },
      },
      "/api/v1/sync": {
        get: { tags: ["Auto-sync"], summary: "List synced repositories", responses: { "200": ok("List", { type: "object", properties: { object: { const: "list" }, data: { type: "array", items: ref("Sync") } } }), ...errs(401, 403) } },
        post: {
          tags: ["Auto-sync"],
          summary: "Auto-regenerate docs on every push",
          description: "Returns `payloadUrl` and `secret` to configure a GitHub repository webhook (content type JSON, push event). Public repositories only.",
          requestBody: body(ref("GenerateRequest"), { repoUrl: "https://github.com/octocat/Hello-World", types: ["readme"] }),
          responses: { "201": ok("Sync created", ref("Sync")), ...errs(400, 401, 403, 409, 422) },
        },
      },
      "/api/v1/sync/{id}": {
        get: { tags: ["Auto-sync"], summary: "Get a sync subscription", parameters: [idParam("id", "Sync id (sync_...)")], responses: { "200": ok("Sync", ref("Sync")), ...errs(401, 403, 404) } },
        delete: { tags: ["Auto-sync"], summary: "Delete a sync subscription", parameters: [idParam("id", "Sync id")], responses: { "204": { description: "Deleted" }, ...errs(401, 403, 404) } },
      },
      "/api/v1/hooks/github/{token}": {
        post: {
          tags: ["Auto-sync"],
          summary: "Incoming GitHub webhook receiver",
          description: "Called by GitHub, not by API clients. Authenticated by the `X-Hub-Signature-256` HMAC. `ping` -> 200, `push` to the tracked branch -> 202 and a new document set, other events/branches -> 200 with `ignored`.",
          security: [],
          parameters: [idParam("token", "Opaque token from the sync payloadUrl")],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "200": { description: "Ping answered or event ignored" },
            "202": { description: "Regeneration queued" },
            ...errs(400, 401, 404, 429),
          },
        },
      },
    },
    webhooks: {
      "doc.completed": {
        post: {
          summary: "A document set finished generating",
          description: `Event types you can subscribe to: ${WEBHOOK_EVENTS.join(", ")}.`,
          requestBody: body(ref("WebhookEvent"), {
            id: "evt_Qm4x2", type: "doc.completed", apiVersion: "v1", createdAt: "2026-11-19T10:00:00.000Z",
            data: { id: "doc_Zk3kQ1x8aB7n", status: "completed", repo: { fullName: "octocat/Hello-World" }, types: ["readme"], health: { before: 18, after: 92 } },
          }),
          responses: { "2XX": { description: "Acknowledge with any 2xx status within 8 seconds." } },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKey: { type: "http", scheme: "bearer", bearerFormat: "rsk_<id>_<secret>", description: "Also accepted in the `X-API-Key` header." },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "requestId"],
          properties: {
            error: { type: "object", required: ["code", "message"], properties: { code: { type: "string", example: "invalid_api_key" }, message: { type: "string" }, details: {} } },
            requestId: { type: "string", example: "req_9f2c1a7b4d3e8a10" },
          },
        },
        Health: {
          type: "object",
          properties: {
            status: { enum: ["ok", "degraded"] }, version: { type: "string" }, time: { type: "string", format: "date-time" },
            checks: { type: "object", properties: { store: { type: "string" }, llm: { type: "string" }, github: { type: "string" } } },
          },
        },
        ApiKeyInfo: {
          type: "object",
          properties: {
            id: { type: "string" }, name: { type: "string" }, scopes: { type: "array", items: { enum: [...ALL_SCOPES] } }, keyPreview: { type: "string" },
            createdAt: { type: "string", format: "date-time" }, lastUsedAt: { type: ["string", "null"], format: "date-time" }, revoked: { type: "boolean" },
            limits: { type: "object", properties: { requestsPerMinute: { type: "integer" }, generationsPerDay: { type: "integer" } } },
            usage: { type: "object", properties: { generationsToday: { type: "integer" }, generationsRemainingToday: { type: "integer" }, quotaResetsAt: { type: "string", format: "date-time" } } },
          },
        },
        ApiKeyCreated: {
          allOf: [ref("ApiKeyInfo"), { type: "object", properties: { apiKey: { type: "string", example: "rsk_a1b2c3d4e5f6_AbCdEfGhIjKlMnOpQrStUvWxYz012345" }, warning: { type: "string" } } }],
        },
        AnalyzeRequest: {
          type: "object", required: ["repoUrl"],
          properties: { repoUrl: { type: "string", description: "https://github.com/owner/repo, github.com/owner/repo or owner/repo" }, branch: { type: "string" } },
        },
        GenerateRequest: {
          type: "object", required: ["repoUrl"],
          properties: {
            repoUrl: { type: "string" },
            branch: { type: "string", description: "Defaults to the repository's default branch." },
            types: { type: "array", minItems: 1, items: { enum: [...DOC_TYPES] }, default: ["readme"] },
            style: { enum: [...STYLES], default: "standard" },
            language: { type: "string", default: "English", description: "Output language for prose (letters, spaces, hyphens only)." },
            includeBadges: { type: "boolean", default: true },
            async: { type: "boolean", default: false },
          },
        },
        RefineRequest: {
          type: "object", required: ["type", "instruction"],
          properties: { type: { enum: [...DOC_TYPES] }, instruction: { type: "string", minLength: 3, maxLength: 500 } },
        },
        Health_Check: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, passed: { type: "boolean" }, weight: { type: "integer" }, hint: { type: "string" } } },
        ReadmeHealth: {
          type: "object",
          properties: { score: { type: "integer", minimum: 0, maximum: 100 }, grade: { enum: ["A", "B", "C", "D", "F"] }, checks: { type: "array", items: ref("Health_Check") } },
        },
        Analysis: {
          type: "object",
          properties: {
            languages: { type: "array", items: { type: "object", properties: { name: { type: "string" }, percent: { type: "number" } } } },
            stack: { type: "array", items: { type: "string" } },
            scripts: { type: "object", additionalProperties: { type: "string" } },
            envVars: { type: "array", items: { type: "string" } },
            entryPoints: { type: "array", items: { type: "string" } },
            fileCount: { type: "integer" },
            analyzedFiles: { type: "array", items: { type: "object", properties: { path: { type: "string" }, bytes: { type: "integer" }, truncated: { type: "boolean" } } } },
            flags: { type: "object", additionalProperties: { type: "boolean" } },
            treeTruncated: { type: "boolean" },
          },
        },
        AnalysisResponse: {
          type: "object",
          properties: { object: { const: "analysis" }, repo: { type: "object" }, analysis: ref("Analysis"), health: { type: "object", properties: { readme: ref("ReadmeHealth") } } },
        },
        DocumentSet: {
          type: "object",
          properties: {
            object: { const: "document_set" }, id: { type: "string" }, status: { enum: ["queued", "running", "completed", "failed"] },
            source: { enum: ["api", "sync"] }, repo: { type: "object" }, options: { type: "object" },
            progress: { type: "object", properties: { step: { type: "string" }, completed: { type: "integer" }, total: { type: "integer" } } },
            documents: { type: "object", additionalProperties: { type: "object", properties: { markdown: { type: "string" }, model: { type: "string" }, promptTokens: { type: "integer" }, outputTokens: { type: "integer" }, generatedAt: { type: "string" }, revisions: { type: "integer" } } } },
            analysis: { oneOf: [ref("Analysis"), { type: "null" }] },
            health: { type: ["object", "null"], properties: { before: { oneOf: [ref("ReadmeHealth"), { type: "null" }] }, after: { oneOf: [ref("ReadmeHealth"), { type: "null" }] } } },
            warnings: { type: "array", items: { type: "string" } },
            error: { type: ["object", "null"], properties: { code: { type: "string" }, message: { type: "string" } } },
            cached: { type: "boolean" },
            usage: { type: "object", properties: { promptTokens: { type: "integer" }, outputTokens: { type: "integer" }, durationMs: { type: "integer" } } },
            createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, completedAt: { type: ["string", "null"], format: "date-time" },
            links: { type: "object", properties: { self: { type: "string" }, markdown: { type: "string" } } },
          },
        },
        DocumentSetSummary: {
          type: "object",
          properties: {
            id: { type: "string" }, status: { type: "string" }, repo: { type: "object" }, types: { type: "array", items: { type: "string" } },
            cached: { type: "boolean" }, health: { type: ["object", "null"] }, source: { type: "string" },
            createdAt: { type: "string", format: "date-time" }, completedAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        WebhookCreateRequest: {
          type: "object", required: ["url"],
          properties: {
            url: { type: "string", description: "HTTPS endpoint that will receive POSTs." },
            events: { type: "array", items: { enum: [...WEBHOOK_EVENTS] }, default: ["doc.completed", "doc.failed"] },
            description: { type: "string", maxLength: 120 },
          },
        },
        Webhook: {
          type: "object",
          properties: {
            object: { const: "webhook" }, id: { type: "string" }, url: { type: "string" }, events: { type: "array", items: { enum: [...WEBHOOK_EVENTS] } },
            description: { type: ["string", "null"] }, active: { type: "boolean", description: "Auto-disabled after 10 consecutive failed deliveries." },
            failureCount: { type: "integer" }, createdAt: { type: "string", format: "date-time" },
          },
        },
        WebhookCreated: { allOf: [ref("Webhook"), { type: "object", properties: { secret: { type: "string", example: "whsec_..." }, note: { type: "string" } } }] },
        Delivery: {
          type: "object",
          properties: {
            id: { type: "string" }, event: { enum: [...WEBHOOK_EVENTS] }, status: { enum: ["success", "failed"] }, attempts: { type: "integer" },
            responseStatus: { type: ["integer", "null"] }, error: { type: ["string", "null"] }, durationMs: { type: "integer" }, at: { type: "string", format: "date-time" },
          },
        },
        WebhookEvent: {
          type: "object",
          properties: {
            id: { type: "string" }, type: { enum: [...WEBHOOK_EVENTS] }, apiVersion: { const: "v1" }, createdAt: { type: "string", format: "date-time" }, data: { type: "object" },
          },
        },
        Sync: {
          type: "object",
          properties: {
            object: { const: "sync" }, id: { type: "string" }, repo: { type: "string" }, options: { type: "object" },
            payloadUrl: { type: "string" }, secret: { type: "string", description: "Only present in the creation response." },
            createdAt: { type: "string", format: "date-time" }, lastTriggeredAt: { type: ["string", "null"] }, triggerCount: { type: "integer" },
          },
        },
      },
    },
  };
}
