# RepoScribe - GitHub Repository Documentation Generator

Paste a GitHub repository link and RepoScribe reads the code, then **Gemini** writes the documentation:
`README.md`, `ARCHITECTURE.md` (with a rendered Mermaid diagram), `API.md`, `CONTRIBUTING.md` and `CHANGELOG.md`.
It scores the existing README before and after, and exposes everything through a documented REST API with
API-key authentication and signed webhooks.

> GenAI Applications (BTIN337) - CIA-P individual project.  Stack: Next.js 16 (App Router) + TypeScript, Gemini REST API, Upstash Redis, Vercel.

## Assignment requirements -> where they are met

| # | Requirement | Implementation |
|---|-------------|----------------|
| 1 | Functional application | Web UI at `/` (generate, preview, edit-by-instruction, export) and `/developers` |
| 2 | Deployment on Vercel | Standard Next.js project, no custom server - see [Deploy to Vercel](#deploy-to-vercel) |
| 3 | Direct Gemini integration | `src/lib/gemini.ts` calls `generateContent` over REST with `fetch` (no wrapper libraries) |
| 4 | API export methods | `POST /api/v1/generate`, `POST /api/v1/analyze`, `GET /api/v1/docs`, `GET /api/v1/docs/{id}?format=json\|markdown` ... |
| 5 | Webhooks | Outbound signed webhooks (`/api/v1/webhooks`) **and** an incoming GitHub-push receiver (`/api/v1/hooks/github/{token}`); JSON in/out, proper status codes |
| 6 | API-key authentication | `src/lib/auth.ts` - structured `rsk_<id>_<secret>` keys, hashed at rest, scopes, per-key rate limits, rotate/revoke |
| 7 | API documentation | OpenAPI 3.1 spec at `/api/v1/openapi.json`, interactive Swagger UI at `/docs` |
| - | Secrets in `.env`, not in code | `.env.example` + `.env*` git-ignored; nothing is hard-coded |

## Features

**Generation**
- 5 document types, 4 styles (concise / standard / detailed / beginner), any output language
- Smart file selection: ranks manifests, entry points, routes and docs, skips lockfiles / `node_modules` / binaries, fits a fixed context budget
- Deterministic analysis with no LLM cost: languages, tech stack, scripts, environment variables, tests / CI / Docker detection
- **README health score (0-100)** before and after, with concrete suggestions
- Mermaid architecture diagram rendered in the browser (falls back to the source if the model emits invalid syntax)
- "Refine" any document with a natural-language instruction
- Results cached by repository content (git tree SHA) + options, so an unchanged repo costs **zero** Gemini quota
- Live progress for long jobs (async mode + polling), private repos via a per-request GitHub token

**API platform**
- API keys: self-service creation, scopes (`generate`, `read`, `webhooks`), rate limit per minute, daily generation quota, rotate, revoke
- Webhooks: HMAC-SHA256 signatures with timestamp (replay protection), retries with backoff, delivery log, auto-disable after repeated failures, SSRF protection
- **Auto-sync**: add a GitHub webhook once and docs regenerate on every push (signature-verified, idempotent, debounced)
- Uniform error envelope, `X-Request-Id`, `Retry-After`, `X-RateLimit-*` headers, CORS

## Quick start (local)

Requires Node 20+ and a free Gemini API key from <https://aistudio.google.com/apikey>.

```bash
npm install
cp .env.example .env.local        # Windows PowerShell: copy .env.example .env.local
# edit .env.local and set GEMINI_API_KEY (and optionally GITHUB_TOKEN)
npm run dev                        # http://localhost:3000
```

Without Redis credentials the app stores data in `.data/store.json` (git-ignored), so no database is needed locally.

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `GEMINI_API_KEY` | yes | Gemini API key |
| `GEMINI_MODEL` | no | Default `gemini-flash-latest`. If a model id is unknown the app falls back to `GEMINI_FALLBACK_MODELS` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | on Vercel | Persistent store. `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Vercel integration names) also work |
| `GITHUB_TOKEN` | **strongly recommended in production** | Anonymous GitHub API access is 60 requests/hour *per IP* and Vercel IPs are shared, so deployed apps hit the limit fast. Use a token that can only read public data |
| `RATE_LIMIT_PER_MINUTE`, `GENERATIONS_PER_DAY`, `KEY_ISSUE_PER_HOUR` | no | Defaults 30 / 20 / 10 |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS` | no | `true` only for local webhook testing; keep `false` in production |
| `PUBLIC_BASE_URL` | no | Override the origin used in links |

## Deploy to Vercel

1. Push this project to a GitHub repository and **Import** it in Vercel (framework preset: Next.js, no settings to change).
2. **Storage**: Project -> Storage -> Marketplace -> **Upstash Redis** -> Connect (free tier). This injects the `KV_REST_API_*` variables automatically.
3. **Settings -> Environment Variables**: add `GEMINI_API_KEY` and `GITHUB_TOKEN` (and optionally `GEMINI_MODEL`).
4. Deploy. Open `/api/v1/health` - it should report `{"status":"ok"}` with `store: "upstash"`, `llm: "configured"`.
5. Smoke test the live deployment: `BASE=https://<your-app>.vercel.app node scripts/e2e.mjs` (webhook checks run only locally).

Notes: generation routes declare `maxDuration = 60`, the maximum on the Hobby plan. Jobs that are cut off anyway are marked failed on the next read instead of hanging forever.

## Using the API

Create a key (public, rate limited per IP) and call the API:

```bash
curl -X POST https://<host>/api/v1/keys -H "Content-Type: application/json" -d '{"name":"my script"}'
# -> { "apiKey": "rsk_a1b2c3d4e5f6_...", ... }   (shown once)

export KEY=rsk_a1b2c3d4e5f6_...

# generate (sync). Add "async": true to get 202 + Location and poll /docs/{id}
curl -X POST https://<host>/api/v1/generate \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"repoUrl":"https://github.com/octocat/Hello-World","types":["readme","architecture"],"style":"standard"}'

# export Markdown
curl -H "Authorization: Bearer $KEY" "https://<host>/api/v1/docs/<id>?format=markdown&type=readme&download=1" -o README.md
```

| Method & path | Scope | Purpose |
|---------------|-------|---------|
| `POST /api/v1/keys` | public | Create an API key |
| `GET / DELETE /api/v1/keys/me`, `POST /api/v1/keys/me/rotate` | any | Inspect, revoke, rotate |
| `POST /api/v1/analyze` | generate | Deterministic repo analysis + README score (no LLM) |
| `POST /api/v1/generate` | generate | Generate docs (sync `201` / async `202`) |
| `GET /api/v1/docs`, `GET / DELETE /api/v1/docs/{id}` | read / generate | List, fetch or export (`format=json\|markdown`), delete |
| `POST /api/v1/docs/{id}/refine` | generate | Edit a document with an instruction |
| `GET / POST /api/v1/webhooks`, `GET / DELETE .../{id}`, `POST .../{id}/test`, `GET .../{id}/deliveries` | webhooks | Manage outbound webhooks |
| `GET / POST /api/v1/sync`, `GET / DELETE /api/v1/sync/{id}` | webhooks | Auto-regenerate on GitHub push |
| `POST /api/v1/hooks/github/{token}` | signature | Incoming GitHub webhook receiver |
| `GET /api/v1/health`, `GET /api/v1/openapi.json` | public | Health and OpenAPI spec |

Errors always look like `{ "error": { "code": "...", "message": "...", "details": ... }, "requestId": "req_..." }`
with accurate statuses: 400 malformed, 401 auth, 403 scope / private repo, 404, 409, 413, 422 validation, 429 limits, 502 upstream, 503 not configured.

### Webhook payloads and verification

```json
{ "id": "evt_...", "type": "doc.completed", "apiVersion": "v1", "createdAt": "...",
  "data": { "id": "doc_...", "status": "completed", "repo": { "fullName": "octocat/Hello-World" },
            "types": ["readme"], "health": { "before": 8, "after": 78 }, "links": { "self": "https://<host>/api/v1/docs/doc_..." } } }
```

Headers: `X-RepoScribe-Event`, `X-RepoScribe-Delivery`, `X-RepoScribe-Timestamp`, `X-RepoScribe-Signature: v1=<hex>` where
`hex = HMAC_SHA256(secret, timestamp + "." + rawBody)`. Reject timestamps older than 5 minutes. A ready-to-copy Node verifier is on the Developers page.
Events: `doc.completed`, `doc.failed`, `sync.triggered`, `ping`.

## Security design

- API keys are stored only as SHA-256 hashes; unknown ids and wrong secrets return the same error (no key enumeration); secrets are shown once.
- **Prompt-injection hygiene**: repository text is untrusted. It is fenced in tags, tag look-alikes inside files are neutralised, the system prompt forbids following instructions found in it, and `language`/`style` are strictly validated.
- **SSRF guard** for webhook URLs (https only, no credentials, no loopback / private / link-local / cloud-metadata addresses, DNS re-checked on every attempt, redirects never followed).
- GitHub only ever contacted at `api.github.com` and `raw.githubusercontent.com`. A caller's GitHub token is used for that request only (never stored or logged), and the shared server token can **never** read a private repo.
- Markdown is rendered without raw HTML; Mermaid runs with `securityLevel: "strict"`.
- Gemini key travels in a header (not the URL); upstream error bodies are never echoed to clients.
- Tenant isolation: documents, webhooks and syncs belong to the key that created them (other keys get 404).

## Testing

```bash
npm test                 # 100+ unit/integration tests (auth, SSRF, webhooks, Gemini client, pipeline, sync, GitHub errors)
npm run typecheck
npm run build

# end-to-end against a running server (uses real GitHub; fake Gemini for zero quota):
npm run mock:gemini                                   # terminal 1  (port 8787)
GEMINI_API_KEY=fake GEMINI_BASE_URL=http://127.0.0.1:8787 ALLOW_PRIVATE_WEBHOOK_TARGETS=true KEY_ISSUE_PER_HOUR=1000 npm run dev   # terminal 2  (serves http://localhost:3000)
BASE=http://localhost:3000 npm run e2e                # terminal 3  (BASE defaults to http://127.0.0.1:3100)
```

The e2e script performs ~60 checks and stops with a clear message if GitHub's anonymous rate limit is exhausted.

## Add-ons

**Already built in**
1. Multi-document generation (README, architecture, API, contributing, changelog)
2. README health score with before/after and fix suggestions
3. Mermaid architecture diagrams
4. Content-addressed cache (zero quota for unchanged repos)
5. Refine-with-instruction editing
6. Style presets and any output language (incl. Hindi, Kannada)
7. Auto-sync on GitHub push (incoming webhook)
8. Signed outbound webhooks with delivery logs and retries
9. Auto-inserted shields.io badges (deterministic, never hallucinated)
10. Private-repo support via a per-request token
11. Markdown export (single file or combined) over the API

**Good next steps**
- Open a Pull Request with the generated README (GitHub App / fine-grained token with write access)
- A GitHub Action / CLI (`npx reposcribe owner/repo`) that calls the API in CI
- Streaming output (SSE) so text appears as it is generated
- ZIP / PDF / HTML export and a public shareable page per document
- Docstring / JSDoc generation for individual files; monorepo (per-package) docs
- Docs-drift detection: re-score on every push and comment on PRs when docs go stale
- Conditional requests (ETag) to GitHub so repeat analyses cost no rate limit
- Usage analytics dashboard per API key; team workspaces instead of single-key tenants

## Known limitations

- Gemini free-tier limits apply and change over time; the app surfaces them as `llm_rate_limited` (429) and enforces its own daily quota per key.
- Very large repositories are summarised from a ranked subset of files (about 80k characters of context), so details deep in the tree may be missing - always review generated docs.
- Keys are independent tenants (no user accounts); losing a key means losing access to that key's history.
