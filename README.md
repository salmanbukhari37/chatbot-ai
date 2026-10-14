# chatbot-ai

A multi-tenant RAG backend for the AI assistant in APIMatic-generated documentation portals. Each customer portal
gets its own isolated index. Portal content is pushed to the service after a portal is built, retrieval is hybrid
(pgvector + Typesense, with an optional Cohere rerank step), and answers are streamed over Server-Sent Events.

**Status:** Phase 1 is done and multi-tenant: ingestion, hybrid search, and single-pass streaming RAG with
citations. Phase 2 covers the agentic tool-calling loop, conversation memory, query rewriting and `/feedback`.
The CLI and portal-template integration hasn't started yet; see [Integration with apimatic-cli](#integration-with-apimatic-cli).

## Stack

| Concern        | Choice                                                                        |
| -------------- | ----------------------------------------------------------------------------- |
| Runtime        | Node.js ≥ 20.12, TypeScript (strict), CommonJS                                |
| HTTP           | Hono + `@hono/node-server`, SSE via `hono/streaming`                          |
| LLM            | OpenAI `gpt-4o` (answers), `text-embedding-3-large` (3072-d)                  |
| Vector search  | PostgreSQL 16 + pgvector 0.8 (HNSW on `halfvec`, iterative scans)             |
| Keyword search | Typesense                                                                     |
| Rerank         | Cohere `rerank-v3.5` (optional; falls back to fusion order)                   |
| Rate limiting  | Postgres fixed-window counters (`UNLOGGED` table), shared across instances    |
| Observability  | pino structured logs (allow-list error serializer), optional Langfuse traces  |
| Quality        | ESLint `strict-type-checked`, Prettier, `node:test`, versioned SQL migrations |

## Tenancy model

```
APIMatic account (tenantId) ──< portal (prt_…) ──< documents ──< chunks
                                   ├─ baseUrl         where the portal is deployed (citation links)
                                   ├─ allowedOrigins  browser origins allowed to chat (baseUrl's origin is always included)
                                   ├─ public key      pk_live_…  embedded in the portal; identifies it for chat
                                   └─ ingest key      sk_live_…  secret; CI/CLI pushes content for this portal only
```

- **Each portal has its own index.** Every row in Postgres and every document in Typesense carries `portal_id`.
  Every query filters on it: retrieval, ingestion, pruning and deletion. As a second safeguard, retrieval also drops
  any hit whose `portal_id` doesn't match the request.
- **The server decides the tenant, never the client.** A chat request is resolved from its `X-Portal-Key` header.
  Request bodies are strict, so a body can't name a portal.
- **Keys are stored only as SHA-256 hashes.** Raw keys are returned once, when a portal is created or its keys are
  rotated.
- **Versions.** Generated portals don't support multiple API versions, so each portal has a single index and every
  sync replaces it. Pages are tagged with a `section` (`home`, `guides`, `api/<spec>`, `sdks`, …). A chat request can
  include the reader's SDK `language`, and the model then prefers code samples in that language.

## Local setup

Prerequisites: Node.js ≥ 20.12, pnpm 12 (`npm i -g pnpm@12`), Docker.

```bash
pnpm install --frozen-lockfile
cp .env.example .env     # set OPENAI_API_KEY and ADMIN_API_KEY (openssl rand -base64 48)
docker compose up -d     # Postgres+pgvector, Typesense
pnpm dev                 # applies migrations on boot, then listens on :8787
```

### Try it with two tenants

```bash
ADMIN=<your ADMIN_API_KEY>

# 1. Register a portal and keep the returned credentials (shown only once)
curl -s -X POST localhost:8787/v1/admin/portals \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"Acme","tenantId":"acme","baseUrl":"https://docs.acme.test","allowedOrigins":["http://127.0.0.1:23513"]}'

# 2. Ingest a folder of .md/.mdx/.html files into it (CLI equivalent of POST /v1/portals/:id/ingest)
pnpm ingest --portal prt_xxx --source ./fixtures/sample-docs

# 3. Ask a question as the portal's browser widget would
curl -N -X POST localhost:8787/v1/chat/stream \
  -H 'Content-Type: application/json' -H 'X-Portal-Key: pk_live_xxx' -H 'Origin: https://docs.acme.test' \
  -d '{"message":"How do I verify webhook signatures?","sessionId":"demo-1"}'
```

`fixtures/portal-globex` is a second tenant in the shape of a real portal build (`.md` pages, including an
API-reference page that embeds OpenAPI YAML).

## API

All routes are versioned under `/v1`. Errors come back as `{ "error": "<code>", ... }`.

### Chat: `POST /v1/chat/stream` (browser)

Headers: `X-Portal-Key: pk_live_…`. Browsers send `Origin` themselves, and it must be one of the portal's
`allowedOrigins`.

Body: `{ "message": string (1–4000), "sessionId": string (1–128, [A-Za-z0-9_-]), "language"?: "csharp" | "typescript" | "python" }`

The response is `text/event-stream`. Every `data:` line holds one JSON event:

| type        | payload                      | when                                                    |
| ----------- | ---------------------------- | ------------------------------------------------------- |
| `tool_call` | `{ tool }`                   | retrieval starts                                        |
| `token`     | `{ content }`                | each streamed answer token                              |
| `sources`   | `{ data: [{ url, title }] }` | after the answer: the pages it cited, in citation order |
| `error`     | `{ message }`                | generation failed (the message is generic)              |
| `done`      | –                            | always last                                             |

If retrieval is down, the service still answers from model knowledge and says it couldn't check the docs. Possible
status codes: `401` for a bad or missing key or a disabled portal, `403` for an origin the portal doesn't allow,
`429` when rate limited (with `RateLimit`, `RateLimit-Policy` and `Retry-After` headers).

> These events use the format from the spec, which is **not** the Vercel AI SDK data-stream protocol. To use them
> with `useChat`, parse the SSE yourself: split on `\n\n` and `JSON.parse` each line that starts with `data: `.

### Ingest: `POST /v1/portals/:portalId/ingest` (CI / CLI)

Headers: `Authorization: Bearer <sk_live_… ingest key>`. The admin key also works for any portal.

```jsonc
{
  "files": [{ "path": "guides/intro.md", "content": "...", "lastModified": "2026-10-14T10:00:00Z" }],
  "force": false, // re-chunk unchanged pages (identical chunks still reuse their embeddings)
  "prune": true, // default: the upload is the whole portal, so pages missing from it are removed
}
```

- `.md`, `.mdx` and `.html` files are accepted. Paths must be relative and use `/`, with no `.` or `..` segments
  and no control characters.
- Limits: 10,000 files, 2 MB per file, `INGEST_MAX_BODY_MB` per request.
- The call returns `202` with a job and a `Location` header. Poll `GET /v1/portals/:portalId/ingest/jobs/:jobId`
  or `…/jobs/latest`. You'll get `409` if a job is already running for that portal.
- Only one job runs per portal, enforced by a unique index in Postgres, so this holds across instances. If an
  instance crashes mid-job, the job is marked failed once it has gone 2 minutes without a heartbeat.

### Admin: `/v1/admin/portals` (server-to-server)

Headers: `Authorization: Bearer <ADMIN_API_KEY>`. The admin API doesn't exist (`404`) when no admin key is set.

| Method & path                            | Purpose                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /v1/admin/portals`                 | Register `{ name, tenantId, baseUrl, allowedOrigins?, rateLimitPerMinute? }`; returns the keys once |
| `GET /v1/admin/portals[?tenantId=]`      | List portals                                                                                        |
| `GET /v1/admin/portals/:id`              | Get a portal                                                                                        |
| `PATCH /v1/admin/portals/:id`            | Update name, baseUrl, allowedOrigins, status (`active`/`disabled`), rate limit                      |
| `POST /v1/admin/portals/:id/rotate-keys` | Issue new keys; the old ones stop working immediately                                               |
| `DELETE /v1/admin/portals/:id`           | Delete the portal and all of its indexed data                                                       |

### `GET /health`

Returns `200` when Postgres and Typesense are reachable and `503` otherwise.

## Ingestion details

- **Parsing.** gray-matter reads the frontmatter (`title`, `slug`, `description`, `lastModified`). MDX is stripped
  of ESM statements, JSX comments and component tags, but children and visible `title` attributes are kept. Code is
  never modified, and fences nested inside JSX are dedented. A page's H1 becomes its title when the frontmatter has
  none, which suits the `.md` copies the portal build produces.
- **Slugs** follow the portal's routes. `guides/intro.md` becomes `guides/intro`, `index` files collapse, and
  `(group)` folders are dropped. URLs are built as `baseUrl/slug`, so portals hosted under a sub-path work.
- **Chunking** splits on H2/H3. Each chunk holds at most 512 tokens with 64 tokens of overlap, and carries a
  `# Title > Heading` prefix.
- **Idempotency.** A page with the same content and URL is skipped. Chunk IDs are
  `sha256(portal, slug, content)`, so only new chunks get embedded.
- **Pruning** is skipped whenever any file failed to parse, so a broken build can't delete good pages.

## Retrieval

1. Embed the query.
2. Run pgvector (top 20, filtered by portal, using an iterative HNSW scan) and Typesense (top 20, filtered by
   portal) in parallel. If one of them fails, the other's results are still used.
3. Min-max normalise each list and fuse the scores as `0.6 · vector + 0.4 · keyword`.
4. Keep the best chunk per page.
5. Rerank with Cohere and keep the top 5.

## Security

- **Tenant isolation:** see [Tenancy model](#tenancy-model).
- **Credentials.** Keys have prefixes and are stored hashed. The admin key is compared in constant time and must be
  at least 32 characters; the example placeholder is rejected at boot. The public key is not a secret. Origin checks
  stop other websites from embedding it, and per-portal and per-IP rate limits stop abuse.
- **CORS** answers preflights only for origins registered by an active portal. The real request is then checked
  against that portal's own origins. The admin and ingest APIs send no CORS headers.
- **Input limits.** zod validates every input and rejects unknown keys. Body limits are 32 KB for chat, 64 KB for
  admin and configurable for ingest.
- **Rate limits** are counted in a Postgres `UNLOGGED` table per portal+IP, per portal, and for ingest and admin.
  Each instance prunes expired counters every 5 minutes. If a counter can't be updated, the request is allowed
  through and the failure is logged.
- **Errors and logs.** Clients get generic errors with a request ID. Logs use an allow-list error serializer,
  because HTTP client errors carry auth headers. Responses include `secureHeaders` with `default-src 'none'`.
- **Prompt injection.** Retrieved text is wrapped in delimited `<doc>` blocks with escaped attributes and
  neutralised delimiters, and the system prompt tells the model to treat it as data.
- **Queries.** All SQL is parameterised. Typesense filters are built by a single helper that always puts the portal
  clause first.

## Operations

- **Migrations** live in `src/db/migrations.ts`. They are append-only, versioned in `schema_migrations`, and run on
  boot under an advisory lock, so several replicas can start at the same time.
- **Caches.** Portal key and origin lookups are cached for 30 s per instance. On other instances, disabling a portal
  or rotating its keys takes up to 30 s to take effect.
- **Typesense is a derived index.** Postgres is the source of truth. Re-ingesting with `force: true` rebuilds a
  portal's Typesense documents.

## Integration with apimatic-cli

A review of `apimatic-cli` produced this plan for the next step:

- **Config.** Add `portal.ai.assistant` (`enabled`, `portalKey`, `apiUrl`) to `apimatic.json`. It flows through
  `PortalIdentity` → `portal.identity.json` into the browser. Environment variables are intentionally blocked from
  the build, so they can't be used for this.
- **Widget.** Mount it in `portal-template/src/routes/__root.tsx`. It must be SSR-safe because pages are prerendered.
- **Sync.** Add an explicit step, e.g. `apimatic portal generate --sync-assistant` or `apimatic portal assistant
sync`, that uploads the build output's per-page `.md` files to `/v1/portals/:id/ingest`. Keep it separate from
  local previews so drafts never overwrite the live index.
- **Open question.** Can the service verify an APIMatic auth key server-side, e.g. via `/account/profile` →
  `tenantId`? If so, the CLI could use the user's existing login instead of a separate ingest key.

## Development

```bash
pnpm check           # typecheck + lint + format check + unit tests
pnpm test            # parser, chunker, fusion, tenancy and validation tests (no services needed)
```

## Known limitations and next steps

- Phase 2: the agent loop (`search_docs`, `get_page`, `search_code_examples`, at most 5 iterations), conversation
  memory in Postgres (10 turns per session, 24 h TTL), query rewriting and `/feedback`.
- Ingest jobs run inside the API process. For heavy load, move them to a Postgres-backed queue such as pg-boss.
- `pnpm audit` reports 1 moderate finding, in gray-matter's `js-yaml@3` → `argparse` chain. The vulnerable code
  only runs in js-yaml's CLI, so it isn't reachable from this service.
- Cohere trial keys are rate-limited, so use a production key before launch.
