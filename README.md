# Amem — Agent MEMory

> **Self-hosted, local-first knowledge & memory for AI agents.**

[![CI](https://github.com/fuyucn/amem/actions/workflows/ci.yml/badge.svg)](https://github.com/fuyucn/amem/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)
[![Docker](https://img.shields.io/badge/docker-compose-2496ed?logo=docker&logoColor=white)](docker/docker-compose.yml)

Amem is a single binary/container that gives your agents (Codex, Claude Code, Cursor, …) a **shared, persistent knowledge graph** — so they stop re-explaining themselves, stop hallucinating from stale context, and stop wasting tokens on duplicate memory. The LLM does the curation dirty-work (distill, cross-link, organize, keep it consistent); you browse and steer. The knowledge base snowballs.

It is the open, self-hostable answer to `llm-wiki` / `obsidian-wiki` / vendor lock-in: **we provide the service, your data is yours** (local SQLite, fully exportable, OKF-compatible).

## Why

- **Reduce context waste** — recall returns a compact, cited context block within a token budget instead of raw history; dedup skips re-storing known knowledge.
- **Reduce hallucination** — answers ground on units with citations; stable conclusions ("crystals") require ≥3 independent sources.
- **Reduce duplicate data** — embedding-based dedup + merge across sessions and tools.
- **LLM as librarian, not search engine** — it maintains the knowledge base for you: summarizing, cross-referencing, classifying, keeping it consistent — continuously, in the background.
- **Data sovereignty** — runs locally, stores in `amem.db` on your disk, exports to JSON or an OKF markdown bundle anytime.

## Features

- **AI-first storage**: a knowledge **graph** (units = nodes, typed links = edges), not markdown files. Markdown is only an export format (OKF).
- **Three memory forms**: Trace (raw) → Unit (atomic, 8 types) → Crystal (cross-validated).
- **Zones (project partitions)**: knowledge is auto-routed into `inbox` / `shared` / `personal` / `project` zones under each workspace — organized by project and access-isolated per account (A never sees B's private zone; recall never crosses zones by default).
- **Auto-organization**: distillation, dedup/merge, link (cross-reference) generation, contradiction detection, crystal promotion, decay/forgetting.
- **Working memory**: a daily compact briefing of the most relevant knowledge (attention prefetch).
- **MCP server**: read/write the graph from Codex, Claude Code, Cursor, and any MCP client.
- **REST API**: full CRUD + search + recall + import/export + stats.
- **Web dashboard**: interactive graph, hybrid search, trace viewer, review queue, stats.
- **Self-contained**: zero-config offline mode (deterministic embedder, no network); drop in an OpenAI-compatible LLM/embedding endpoint for semantic quality.

### Web UI routes

The dashboard is a real URL-routed SPA (no hash routing) — every tab is a deep-linkable path:

| Route | View |
| --- | --- |
| `/activity` | live write/recall feed (default) |
| `/dashboard` | stats & memory metrics |
| `/graph` | interactive knowledge graph |
| `/search` | hybrid search / recall |
| `/units` | atomic memory units |
| `/units/:id` | unit detail (deep-linkable; graph nodes & list rows open this) |
| `/traces` | raw ingestion traces |
| `/working-memory` | daily working-memory briefing |
| `/review` | curation review queue |
| `/zones` | zone management (list, create, membership, auto-route) |
| `/settings` | auth, workspaces, AI providers, PATs, agent (MCP) connection |

Legacy `/#/graph`-style hash links are automatically redirected to the path routes. Server-side SPA fallback means any of these URLs can be opened, refreshed, or shared directly.

## Quick start

### One-command Docker (recommended)

```sh
docker compose -f docker/docker-compose.yml up --build -d
# open http://localhost:8321
```

Pre-built images are published to GHCR on every tag:

```sh
docker run -d --name amem -p 8321:8321 -v "$(pwd)/data:/data" \
  ghcr.io/fuyucn/amem:v0.1.0
```

Set `AMEM_EMBEDDING_BASE_URL` / `AMEM_LLM_BASE_URL` (+ model/key) in your env for semantic + LLM distillation. Works offline out of the box.

### Setup wizard (detect → plan → apply → verify)

```sh
pnpm setup            # or: node tools/amem-setup.mjs all
node tools/amem-setup.mjs detect | plan | apply | verify
```

The wizard checks the running service, wires a Personal Access Token into
`~/.codex/config.toml`, installs the Stop/SessionEnd ingest hook, and verifies the
MCP OAuth challenge (`401 + WWW-Authenticate`) plus a PAT-authenticated MCP session.
Run `node tools/amem-setup.mjs verify` any time to confirm the install is healthy.

### Local (dev)

```sh
pnpm install
pnpm build
pnpm --filter @amem/server start     # API + web on http://127.0.0.1:8321
```

## AI providers (Settings → AI Providers)

Amem's automatic organization (distillation on ingest, link generation, curation
summaries, contradiction review) is powered by an OpenAI-compatible LLM endpoint.
Configure it in the Web UI — no env vars or restarts needed:

1. Open **Settings → AI Providers** and pick a quick-fill preset (DeepSeek,
   OpenAI, OpenRouter, Ollama, or a custom local gateway such as an opencode Go
   service, vLLM, or LM Studio).
2. Fill `name`, `base URL`, `model`, and (optional) `API key`, then **Save provider**.
3. Hit **Test** to probe `/models` (falls back to a 1-token chat completion), then
   **Activate**. The LLM is hot-swapped — every AI feature uses it immediately.

Priority: **active provider → `AMEM_LLM_*` env → offline (mock)**. Keys are
AES-256-GCM encrypted at rest (derived from `AMEM_AUTH_SECRET`) and never
returned by the API — only `hasKey` + a 6-char prefix are exposed.

Semantic search quality uses a separate embedding endpoint (env only, since many
chat providers don't offer embeddings):

```sh
AMEM_EMBEDDING_MODE=api AMEM_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1 \
AMEM_EMBEDDING_MODEL=nomic-embed-text AMEM_EMBEDDING_API_KEY=... \
pnpm --filter @amem/server start
```

Without any LLM or embedding config, Amem runs fully offline with a deterministic
embedder and a mock LLM — every feature works, semantic quality is just lower.

## Knowledge graph hygiene

Auto-linking is **degree-bounded** so the graph stays readable and cheap to
traverse: every unit keeps at most `maxLinksPerUnit` auto links (default `8`,
set via `AMEM_MAX_LINKS_PER_UNIT`), chosen by confidence. Typed relations
(`supports` / `part_of` / `extends` / …) are only assigned when two units are
semantically similar — the weaker shared-tag signal only ever produces
`related_to`, so a generic tag can't mass-produce fake typed hubs. The graph
API also caps `related_to` edges per node for rendering (12/node), keeping the
force layout readable even on large histories.

Existing databases that predate these caps can be repaired in one call (API
`POST /api/v1/links/prune` with `{ "maxPerUnit": 8 }`, MCP `prune_links`):

```sh
curl -X POST -H "Authorization: Bearer $AMEM_PAT" -H "Content-Type: application/json" \
  -d '{"maxPerUnit":8,"dryRun":true}' http://127.0.0.1:8321/api/v1/links/prune
```

Run with `dryRun: true` first to preview `{ examined, kept, deleted }`, then
repeat without it. Manual links and importer-created `part_of` edges are never
touched.

## Codex as first-class client

See [`docs/CODEX.md`](docs/CODEX.md). Open the Web UI **Activity** tab to watch new knowledge and recalls live.

## Connect an agent (write + read)

**Claude Code** `.mcp.json`:

```json
{
  "mcpServers": {
    "amem": { "command": "node", "args": ["/path/to/amem/packages/mcp/dist/cli.js"] }
  }
}
```

**Codex / Cursor / any MCP client**: point at the same command, or at `http://127.0.0.1:8321/mcp` (Streamable HTTP). See `docs/MCP_TOOLS.md`.

Typical loop:

1. Start of session: `working_memory` + `recall "active project"` → warm context.
2. As you work: `save_unit` for decisions/plans/procedures.
3. End of session: `ingest` with the transcript → Amem distills, dedups, and links.
4. Background consolidation keeps the graph consistent and growing.

## REST API

See `docs/API.md`. Base `/api/v1` on `127.0.0.1:8321` by default. Auth modes:

- **None (localhost default)** — `AMEM_AUTH_ENABLED=false`, no bearer required.
- **PAT** — set `AMEM_API_TOKEN` (or use a minted PAT) and send
  `Authorization: Bearer amem_pat_*`. Legacy single-token mode stays behind
  `AMEM_ALLOW_LEGACY_API_TOKEN=true`.
- **OAuth 2.1** — `AMEM_AUTH_ENABLED=true` enables the full authorization flow:
  `.well-known/oauth-authorization-server`, `authorize` + PKCE (S256),
  `token` / `refresh` (rotation + reuse detection), `revoke`. Web UI has a login
  consent page; MCP clients follow the standard `401 → WWW-Authenticate` dance.

## Auth, scopes & workspaces

Amem separates **who** you are (user / login session / PAT) from **what** you can
touch (workspace + scope). Requests are denied server-side before any storage
access — scope checks are not a UI nicety.

### First run onboarding

When authentication is enabled (`AMEM_AUTH_ENABLED=true`), the web UI gates on a
dedicated `/login` page with a three-step wizard:

1. **Account** — sign in, or bootstrap the first admin on a fresh install, or
   paste an existing PAT (Codex / CLI style).
2. **Workspace** — pick an existing isolated namespace or create one (e.g.
   `acme-prod`, `personal`).
3. **Agent token** — mint a least-privilege PAT (`read write` scoped to that
   workspace) and copy the ready-to-paste `~/.codex/config.toml` snippet.

The same actions are available anytime under **Settings**.

- **Scopes**: `read`, `write`, `admin`, plus per-workspace
  `ws:<slug>:read` / `ws:<slug>:write`. Every token carries a scope set; MCP and
  REST enforce it on every call.
- **Workspaces**: isolated namespaces (e.g. `acme-prod`, `acme-labs`,
  `personal`). Units, links, traces, and activity are stored and queried inside
  one workspace only. Users are members with roles (`owner` / `admin` /
  `member` / `reader`).
- **Tokens**: PATs (`amem_pat_*`, signed, TTL + scope-capped) for agents/CLI;
  access tokens (`amem_atk_*`) from the OAuth flow; refresh tokens rotate on
  every use with replay detection.
- **Posture**: a workspace can only tighten (never loosen) the instance default,
  e.g. force auth on even if the instance runs open on localhost.

Full threat model, schema, and setup-wizard design:
[`docs/AUTH_WORKSPACES.md`](docs/AUTH_WORKSPACES.md).

## Docs

- `docs/ARCHITECTURE.md` — design & layering
- `docs/DATA_MODEL.md` — graph schema
- `docs/API.md` — REST API
- `docs/MCP_TOOLS.md` — MCP tools
- `docs/AUTH_WORKSPACES.md` — OAuth / PAT / scopes / workspaces
- `docs/CODEX.md` — Codex integration + Stop hook setup
- `docs/DEPLOYMENT.md` — Docker / compose / config reference
- `docs/DEVELOPMENT.md` — build, test, run
- `docs/BENCHMARK.md` — OmniMemEval / LoCoMo results + real-store recall eval
- `docs/storage-optimization.md` — consolidate/linkgen/storage optimizations + quantified benchmarks
- `docs/TENCENTDB_REFERENCE.md` — design reference vs TencentDB memory engine
- `docs/OPERATIONS.md` — backup / restore / upgrade / monitoring

Self-contained HTML evaluation reports: `docs/bench-report-amem-v3.html`
(LoCoMo run) and `docs/eval-recall-report.html` (real-store recall eval).

Security: [`SECURITY.md`](SECURITY.md) (threat model + hardening checklist).
Community: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) ·
[`CONTRIBUTING.md`](CONTRIBUTING.md). Releases: [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing guidelines, and the
PR process.

## License

MIT
