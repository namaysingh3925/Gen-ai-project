# RepoScribe

GitHub repository documentation generator powered by the Google Gemini API.

RepoScribe analyzes GitHub repositories and automatically generates comprehensive documentation sets including README.md, ARCHITECTURE.md with Mermaid diagrams, API.md, CONTRIBUTING.md, and CHANGELOG.md. It provides deterministic codebase analysis, automated README health scoring before and after generation, content-addressed caching, an OpenAPI-compliant REST API with API key authentication, incoming GitHub push auto-sync webhooks, and signed outbound webhooks.

---

## Table of Contents

- Overview
- Architecture and Technologies
- Exact End-to-End Workflow
- Detailed Component Workflows
  - 1. User Interface and API Ingestion
  - 2. Authentication and Rate Limiting
  - 3. Repository Fetching and Context Budgeting
  - 4. Deterministic Codebase Analysis
  - 5. README Health Scoring Engine
  - 6. LLM Generation Pipeline
  - 7. Post-Processing and Mermaid Rendering
  - 8. Document Refinement
  - 9. Incoming GitHub Auto-Sync Webhook
  - 10. Outbound Event Webhook Delivery
- API Reference
- Environment Variables
- Local Setup and Installation
- Testing and Quality Assurance
- Security Architecture

---

## Overview

RepoScribe inspects public or private GitHub repositories, extracts dependency structures, entry points, routes, and source files, and produces documentation adhering to configurable styles and languages. 

Key capabilities:
- Five document types: README, Architecture, API Reference, Contributing Guidelines, Changelog.
- Four style presets: concise, standard, detailed, beginner-friendly.
- Multi-language output support across global languages.
- Deterministic static analysis with zero LLM consumption for tech stack, scripts, and environment variable discovery.
- Automated README health score from 0 to 100 with actionable feedback before and after generation.
- Zero-quota content-addressed cache keyed by git tree SHA and generation options.
- Interactive Mermaid architecture diagrams rendered in browser with fallback handling.
- Incremental document refinement using natural-language instructions.
- Bi-directional webhook system: incoming GitHub push receivers and HMAC-signed outbound notification webhooks.
- Scoped API key authentication with per-minute rate limiting and daily usage quotas.

---

## Architecture and Technologies

The application is built as a unified full-stack system deployed on serverless architecture:

- Runtime and Framework: Next.js 16 (App Router) with React 19 and TypeScript.
- LLM Provider: Google Gemini REST API (v1beta `generateContent` via direct fetch, supporting gemini-3.5-flash-lite, gemini-flash-latest, and automatic fallback chains).
- Styling: Tailwind CSS v4 with Typography plugin.
- Markdown and Visualizations: React-Markdown, Remark-GFM, and Mermaid.js with strict security isolation.
- Validation: Zod schemas for all API payloads and environment variables.
- Persistence: Key-Value store supporting Upstash Redis / Vercel KV for cloud deployment, with transparent local filesystem fallback for development.
- Testing: Vitest for unit and integration testing.

---

## Exact End-to-End Workflow

The complete execution lifecycle for documentation generation proceeds through the following sequential stages:

```
[User / API Client / GitHub Webhook]
                 |
                 v
   [1. Request Ingestion & Validation]
                 |
                 v
    [2. Auth, Scopes & Rate Limits]
                 |
                 v
  [3. GitHub Repository Snapshot & Tree]
                 |
                 v
      [4. Cache Key Calculation] -------------> [Cache Hit: Return Stored Docs]
                 |
            Cache Miss
                 |
                 v
  [5. File Selection & Context Budgeting]
                 |
                 v
  [6. Deterministic Static Code Analysis]
                 |
                 v
  [7. Pre-Generation README Health Score]
                 |
                 v
 [8. Gemini REST API Parallel Generation]
                 |
                 v
    [9. Post-Processing & Badges]
                 |
                 v
  [10. Post-Generation Health Scoring]
                 |
                 v
    [11. Persistence & Cache Storage]
                 |
                 v
  [12. Outbound Webhook Notification]
```

### High-Level Stage Descriptions

1. Request Ingestion: The user inputs a GitHub URL via the web dashboard or calls `POST /api/v1/generate`.
2. Validation: The request body is verified against Zod schemas ensuring valid URL syntax, branch formatting, allowed document types, style presets, and target language.
3. Access Control: For API requests, bearer tokens or API key headers are verified against SHA-256 hashes in the KV store, checking permissions, per-minute request counts, and daily generation limits.
4. Repository Inspection: The GitHub REST API is queried for metadata and the recursive git tree SHA.
5. Cache Verification: A SHA-256 hash combining the repository full name, branch, tree SHA, document types, style, language, badge flags, and prompt template version is computed. If found in cache, stored documentation is returned immediately without contacting Gemini.
6. File Ranking: Repository files are filtered and ranked based on importance (manifests, entry points, routers, configs) and loaded within an 80,000-character context budget.
7. Static Analysis: Source code and manifests are parsed with zero LLM calls to detect frameworks, dependencies, scripts, and environment variables.
8. Baseline Evaluation: Existing README is scored from 0 to 100 based on coverage criteria.
9. Gemini Generation: Prompts containing system instructions, repository analysis, tree summaries, and source code are sent to Gemini over HTTPS. Generation runs with concurrency control.
10. Post-Processing: Code fences are stripped, Shields.io badges are dynamically attached, and markdown structure is sanitized.
11. Re-Evaluation: Generated README is scored to compute the quality delta.
12. Delivery: Results are saved to the KV store, returned to the caller, and broadcast to subscribed outbound webhooks.

---

## Detailed Component Workflows

### 1. User Interface and API Ingestion

The application exposes two entry surfaces:
- Web Dashboard (`/`): Allows users to submit repository URLs, toggle document options, view real-time progress indicators, preview rendered Markdown with syntax highlighting and interactive Mermaid diagrams, download files, and refine documents with natural-language instructions.
- REST API (`/api/v1/*`): Provides programmatic access for synchronous or asynchronous generation, repository analysis, document retrieval, refinement, and key management.

For asynchronous generation requests (`"async": true`), the server returns HTTP 202 Accepted with a `Location: /api/v1/docs/{id}` header. Clients poll this endpoint until the job status changes from `running` to `completed`.

### 2. Authentication and Rate Limiting

The authentication engine operates as follows:
- Keys are issued via `POST /api/v1/keys` with structured tokens formatted as `rsk_<12_char_id>_<32_char_secret>`.
- The secret is hashed using SHA-256. Only `id`, `name`, `secretHash`, and `scopes` are persisted. Plaintext secrets are never stored.
- Incoming requests provide keys via `Authorization: Bearer <key>` or `X-API-Key: <key>`.
- The engine checks assigned scopes (`generate`, `read`, `webhooks`).
- Sliding-window rate limiters track per-minute requests per key, returning HTTP 429 and `Retry-After` headers if exceeded.
- Daily usage quotas prevent quota exhaustion on upstream Gemini endpoints.

### 3. Repository Fetching and Context Budgeting

Repository retrieval is performed via the GitHub REST API:
- URL parsing extracts owner, repository, and branch references.
- `GET /repos/{owner}/{repo}` fetches default branch, description, stars, license, and primary language.
- `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1` retrieves the complete tree structure.
- When private repository access is needed, a caller-provided GitHub personal access token is passed in memory for that request only and never persisted.
- File selector ignores vendor paths, lockfiles, compiled binaries, images, and `node_modules`.
- Candidate files are prioritized:
  - Manifests: `package.json`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`.
  - Application entry points: `main.*`, `index.*`, `app.*`, `server.*`.
  - Routing and controllers: `src/app/**`, `routes/**`, `api/**`.
  - Configuration: `tsconfig.json`, `Dockerfile`, `docker-compose.yml`.
  - Existing documentation: `README*`, `docs/**`.
- Files are fetched in parallel and truncated when total character volume reaches the 80,000-character safety budget.

### 4. Deterministic Codebase Analysis

Static inspection executes before calling any LLM:
- Node.js ecosystem detection scans dependencies and scripts in `package.json`.
- Python ecosystem detection matches package rules in `requirements.txt`, `pyproject.toml`, or `Pipfile`.
- Go, Rust, Java, and Ruby manifests are matched against known frameworks (Gin, Echo, Fiber, Actix, Axum, Tokio, Spring Boot, Rails).
- Environment variable discovery uses regular expressions across source code to find `process.env.*`, `os.environ[*]`, `os.getenv(*)`, and `System.getenv(*)`.
- System and runtime default variables (`PATH`, `NODE_ENV`, `HOME`) are filtered out.
- Infrastructure detection flags the presence of Docker, GitHub Actions, and test configurations.

### 5. README Health Scoring Engine

The scoring system calculates an objective score between 0 and 100 based on standard documentation components:

| Criterion | Weight | Evaluation Method |
|---|---|---|
| Project Title and Overview | 20 points | Verifies top-level header and summary paragraph |
| Installation Instructions | 15 points | Checks for setup code blocks and dependency install commands |
| Quick Start and Usage | 15 points | Verifies execution commands, code examples, or run scripts |
| Configuration and Environment | 15 points | Scans for environment variable tables or configuration sections |
| Architecture and Structure | 10 points | Looks for architecture overviews, directory maps, or diagrams |
| Contributing and Testing | 10 points | Checks for test execution instructions and contribution guidelines |
| License and Badges | 15 points | Detects license declaration, shields.io badges, or status indicators |

The engine returns both the numerical score and a checklist of missing elements. Scoring is executed on the existing repository README (before) and on the newly generated README (after).

### 6. LLM Generation Pipeline

Documentation writing interfaces directly with Google Gemini REST API:
- System Prompt: Enforces strict documentation standards, technical tone, markdown formatting rules, and prompt-injection defense mechanisms.
- Context Assembly: Combines repository metadata, detected tech stack, ASCII file tree summary, extracted source files, and commit logs.
- Concurrency Control: Document types (`readme`, `architecture`, `api`, `contributing`, `changelog`) are generated in parallel with a concurrency limit of 3 to stay within rate bounds.
- Authentication: The Gemini API key is transmitted via the `x-goog-api-key` header rather than URL query parameters to avoid server logging exposure.
- Failure Handling:
  - Automatic fallback: If the primary model returns 404, the client queries fallback models and records the active model.
  - Exponential backoff: Retries on 429, 500, 502, 503, and 504 errors while respecting upstream `Retry-After` headers.
  - Execution deadline: Terminates ongoing LLM calls before hitting serverless platform execution timeouts (54-second budget).

### 7. Post-Processing and Mermaid Rendering

Post-processing normalizes generated output before delivery:
- Enclosing markdown code blocks are unescaped if wrapped by model output.
- Shields.io badge lines are constructed using repository metadata (license, stars, top language, commit timestamp) and prepended to README files if enabled.
- For ARCHITECTURE documents containing Mermaid diagrams (`flowchart` or `graph`), the browser renderer initializes Mermaid with `securityLevel: 'strict'`.
- If the model emits invalid Mermaid syntax, the UI catches the parse error and displays the raw diagram code with an inline syntax notice rather than breaking the page view.

### 8. Document Refinement

Users can modify generated documents using conversational instructions:
- The client sends `POST /api/v1/docs/{id}/refine` with the document type and a natural-language prompt (such as "Add Docker deployment instructions" or "Simplify the getting started guide").
- Gemini receives the original document, the refinement instruction, and technical context.
- The revised document replaces the previous version, its revision counter increments, and changes are committed to storage.

### 9. Incoming GitHub Auto-Sync Webhook

Automated continuous documentation synchronization is supported for GitHub repositories:
- A user creates a sync subscription via `POST /api/v1/sync`, receiving a webhook payload URL (`/api/v1/hooks/github/{token}`) and a secret.
- The webhook is registered in GitHub repository settings under Webhooks with push events.
- On code push:
  1. GitHub sends a POST request containing `X-Hub-Signature-256`.
  2. The endpoint computes the HMAC-SHA256 signature using the stored secret and validates payload authenticity.
  3. The request checks that the push corresponds to the subscribed branch.
  4. An asynchronous documentation generation job is queued and executed.
  5. Subscribed outbound webhooks receive `sync.triggered` and `doc.completed` notifications.

### 10. Outbound Event Webhook Delivery

Subscribers can receive real-time webhook notifications for project events:
- Supported events: `doc.completed`, `doc.failed`, `sync.triggered`, `ping`.
- SSRF Security: Destination URLs are validated against private IP ranges, loopback addresses, link-local addresses, and cloud provider metadata endpoints (169.254.169.254).
- Payloads are signed with HMAC-SHA256:
  - Header `X-RepoScribe-Timestamp`: Unix epoch timestamp in seconds.
  - Header `X-RepoScribe-Signature`: `v1=<hex_hmac_sha256>`.
  - Signature message: `${timestamp}.${rawJsonBody}`.
- Delivery attempts retry on 5xx errors and network timeouts up to 3 times with exponential backoff (0s, 1s, 4s).
- Webhooks with 10 consecutive delivery failures are automatically disabled.

---

## API Reference

All API responses use JSON envelopes. Errors return structured objects containing `error.code`, `error.message`, and `requestId`.

| Method | Endpoint | Required Scope | Description |
|---|---|---|---|
| POST | `/api/v1/keys` | Public | Create a new scoped API key |
| GET | `/api/v1/keys/me` | Any | Inspect metadata and usage of active key |
| DELETE | `/api/v1/keys/me` | Any | Revoke active API key |
| POST | `/api/v1/keys/me/rotate` | Any | Rotate key secret while preserving ID and settings |
| POST | `/api/v1/analyze` | `generate` | Deterministic static codebase analysis without LLM cost |
| POST | `/api/v1/generate` | `generate` | Generate documentation set (sync 201 or async 202) |
| GET | `/api/v1/docs` | `read` or `generate` | List generated documentation sets for authenticated key |
| GET | `/api/v1/docs/{id}` | `read` or `generate` | Fetch documentation set as JSON or raw Markdown |
| DELETE | `/api/v1/docs/{id}` | `generate` | Delete documentation set |
| POST | `/api/v1/docs/{id}/refine` | `generate` | Refine specific document via natural-language prompt |
| GET | `/api/v1/sync` | `webhooks` | List auto-sync subscriptions |
| POST | `/api/v1/sync` | `webhooks` | Create new auto-sync subscription for GitHub push events |
| GET | `/api/v1/sync/{id}` | `webhooks` | Get sync subscription details |
| DELETE | `/api/v1/sync/{id}` | `webhooks` | Delete sync subscription |
| POST | `/api/v1/hooks/github/{token}` | Signature | Incoming GitHub push webhook receiver |
| GET | `/api/v1/webhooks` | `webhooks` | List outbound webhook registrations |
| POST | `/api/v1/webhooks` | `webhooks` | Register new outbound webhook |
| GET | `/api/v1/webhooks/{id}` | `webhooks` | Get outbound webhook details |
| DELETE | `/api/v1/webhooks/{id}` | `webhooks` | Delete outbound webhook |
| POST | `/api/v1/webhooks/{id}/test` | `webhooks` | Send test ping delivery |
| GET | `/api/v1/webhooks/{id}/deliveries` | `webhooks` | View recent delivery log history |
| GET | `/api/v1/health` | Public | Service health check |
| GET | `/api/v1/openapi.json` | Public | OpenAPI 3.1 specification |

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes | None | Google Gemini API key |
| `GEMINI_MODEL` | No | `gemini-flash-latest` | Primary Gemini model identifier |
| `GEMINI_BASE_URL` | No | `https://generativelanguage.googleapis.com` | Base URL for Gemini REST API calls |
| `UPSTASH_REDIS_REST_URL` | No | None | Upstash Redis URL for production persistence |
| `UPSTASH_REDIS_REST_TOKEN` | No | None | Upstash Redis authentication token |
| `KV_REST_API_URL` | No | None | Vercel KV URL alias |
| `KV_REST_API_TOKEN` | No | None | Vercel KV token alias |
| `GITHUB_TOKEN` | Recommended | None | GitHub personal access token for higher rate limits |
| `RATE_LIMIT_PER_MINUTE` | No | `30` | Allowed requests per minute per key |
| `GENERATIONS_PER_DAY` | No | `20` | Allowed generation runs per day per key |
| `KEY_ISSUE_PER_HOUR` | No | `10` | Allowed key registrations per IP per hour |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS`| No | `false` | Set to true only in local development to test loopback webhooks |
| `PUBLIC_BASE_URL` | No | None | Host URL override for generated webhook links |

---

## Local Setup and Installation

### Prerequisites

- Node.js 20 or higher
- npm package manager
- Gemini API key from Google AI Studio

### Setup Steps

1. Clone the repository:
```bash
git clone https://github.com/your-username/reposcribe.git
cd reposcribe
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment settings:
```bash
cp .env.example .env.local
```

4. Populate environment variables in `.env.local`:
```env
GEMINI_API_KEY=your_actual_gemini_api_key
GITHUB_TOKEN=your_optional_github_token
```

5. Run development server:
```bash
npm run dev
```

6. Access the application:
- Web Application: http://localhost:3000
- Developer Portal: http://localhost:3000/developers
- Swagger Documentation: http://localhost:3000/docs
- OpenAPI Specification: http://localhost:3000/api/v1/openapi.json

---

## Testing and Quality Assurance

The test suite covers unit logic, security barriers, rate limiters, Gemini client retries, webhook signatures, and data pipelines.

Execute the test suite:
```bash
npm test
```

Perform type checking:
```bash
npm run typecheck
```

Build production bundle:
```bash
npm run build
```

---

## Security Architecture

- Credential Protection: API keys are stored solely as SHA-256 hashes. Plaintext keys are shown once during creation and cannot be retrieved from storage.
- Prompt-Injection Hygiene: Untrusted repository content is fenced inside structural delimiters. System prompts strictly forbid models from executing instructions discovered within source repositories.
- Server-Side Request Forgery Prevention: Outbound webhook endpoints resolve domain names and reject loopback, private RFC-1918, link-local, and cloud metadata IP addresses. Webhook requests never follow HTTP redirects.
- In-Memory Token Handling: Private repository tokens provided by callers are used exclusively for on-the-fly GitHub requests and are never written to disk or logged.
- HTML Sanitization: Markdown rendering strips raw HTML tags. Mermaid diagrams execute under strict security isolation mode to prevent script injection.
- Secret Exposure Safeguards: The Gemini API key is provided strictly in HTTP request headers, never exposed in URLs or echoed in client-facing error payloads.
- Multi-Tenant Isolation: Documentation jobs, webhooks, and sync subscriptions are isolated by API key ID. Requests referencing resources owned by another key return HTTP 404 to prevent resource enumeration.
