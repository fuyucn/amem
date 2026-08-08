# Amem — Agent MEMory
*A self-hosted, local-first knowledge & memory layer for AI agents (replacing llm-wiki / obsidian-wiki as the default for agent-scale knowledge).*

## 1. Problem statement

Agents (Codex, Claude Code, Cursor, …) each keep their own private memory. Context is expensive, siloed, and lost.

- Too much context management across long / multi-agent sessions.
- Hallucination from stale or missing grounded facts.
- Duplicate data and token waste (re-saying the same thing in every session).
- Knowledge is locked inside each vendor ("rent the intelligence, own the memory").

**Amem's answer**: one self-hosted, local-first, graph-native knowledge layer any agent and any human can read and write through. The LLM does the curation dirty-work (distill, cross-reference, organize, maintain consistency); the human browses and steers. The knowledge base snowballs.

## 2. Principles

1. **Self-local-data**: Amem is only the service. Data lives in a local SQLite file owned by you, fully exportable at any time (JSON + OKF bundle). No cloud, no lock-in.
2. **AI/LLM-first storage, not markdown**. Canonical storage is a structured knowledge graph (nodes/edges/memories with embeddings and versioning). Markdown is an *export* format (OKF), not the source of truth — so it's easy for agents to consume.
3. **LLM as librarian, not search engine**. Given raw material, the LLM distills atomic units, cross-links them, reconciles contradictions, and keeps the graph consistent — continuously, in the background.
4. **Context efficiency**. Recall returns a compact, cited, token-budgeted context block instead of dumping raw history. Dedup skips re-storing known knowledge.
5. **Human-in-the-loop control**: visible graph, editable, operable, auditable (versions, citations, sources), ubiquitous (Web UI, REST, MCP, CLI).

## 3. Domain model (adapted from OKF + Nowledge-style memory systems)

Three memory forms (episodic→semantic consolidation):

- **Trace** — raw conversation/source material, preserved verbatim (high fidelity).
- **Unit** — extracted atomic knowledge: one idea per unit. Searchable, linkable, evolvable.
- **Crystal** — a stable conclusion cross-validated by >= `MIN_SOURCES` (default 3) independent sources.

Unit types (8): `fact`, `decision`, `plan`, `procedure`, `preference`, `concept`, `lesson`, `question`.

Graph:

- **Node = Unit** (`id`, `type`, `title`, `summary`, `body`, `tags`, `labels`, `embedding`, `status`, `quality`, `confidence`, timestamps, version).
- **Edge = Link** (`id`, `source_unit_id`, `target_unit_id`, `relation`, `reason`, `confidence`, timestamps`). Cross-references auto-generated. Typed relations (e.g. `supports`, `contradicts`, `part_of`, `extends`, `precedes`, `references`, `related_to`).
- **Memory coverage**: a Unit is backed by citations to **Sources**; a Crystal requires >=3 independent sources.
- **Versioning / evolution chain**: each Unit edit creates a Version (bi-temporal: `valid_from/to` + `asserted_at`); `supersedes` links model evolution.
- **Forgetting**: decay scoring + retention policy archives/stales units not reinforced.
- **Working Memory**: a daily compact briefing of the most relevant units today (attention prefetch / L1 cache).

### Core tables (SQLite, single local file `amem.db`)
`w_meta`, `units`, `links`, `traces`, `sources`, `unit_sources` (citations), `versions`, `tags`, `unit_tags`, `sessions`, `jobs` (background pipeline audit), `settings`.

Embeddings stored as JSON (`F32[]`); similarity computed in-process (cosine). FTS5 for keyword search. Hybrid retrieval = keyword + semantic, merged, ranked.

## 4. Architecture

```
agents (Codex/Claude Code/...) ──► MCP server (stdio/HTTP)      ──┐
human/other tools           ──► REST API (Fastify)              ──┤──► core services
Web dashboard (React/Vite)  ──► REST API (served static)        ──┤        │
browser extension / scripts ──► REST / JSON import  [optional]  ──┘        ▼
                                                                   ┌──────────────┐
                                                    core:  distill │  extraction  │
                                                           dedup   │  recall      │
                                                           link    │  consolidate │
                                                           memory  │  working-mem │
                                                                   └───┬──────────┘
                                                                       ▼
                                                      db: SQLite graph store (local file)
```

### Packages
| Pkg | Dir | Responsibility |
|-----|-----|----------------|
| core | `packages/core` | domain types, config, LLM+embedding clients, tokenizer, distillation, dedup, linking, consolidation, recall/context assembly, working memory, OKF export |
| db | `packages/db` | SQLite schema, migrations, repositories, vector utils |
| server | `packages/server` | Fastify REST API, static hosting of web build, health, import/export, background scheduler |
| mcp | `packages/mcp` | MCP server exposing core tools (stdio + streamable HTTP) |
| web | `apps/web` | React dashboard: graph viz, search, traces, review queue, stats, working memory |
| ops | `docker/`, `.github/`, tools | Dockerfile, compose, CI, smoke tests |

## 5. LLM integration (provider-agnostic)

OpenAI-compatible protocol via env config:
- **Embeddings**: `AMEM_EMBEDDING_BASE_URL`, `_MODEL`, `_API_KEY`.
- **Chat/JSON**: `AMEM_LLM_BASE_URL`, `_MODEL`, `_API_KEY`.
- Works with OpenAI, Ollama, LM Studio, vLLM, Together, local proxies.
- **Offline/local mode**: `AMEM_EMBEDDING_MODE=offline` uses a deterministic hashing embedder (no network, still supports semantic-ish + dedup for tests/local).
- A **dispatcher** routes: extract/merge/link/recall-use-chat; embed for retrieval.
- All LLM calls JSON-schema constrained (`response_format`) for determinism.

## 6. Core pipelines

1. **Ingest(source, text, sessionId)** → save Trace → distill → candidate Units → dedup/merge vs existing → persist (status `pending`→`reviewed`) → schedule consolidation.
2. **Recall(query, tokenBudget)** → hybrid retrieve top-k → rank (similarity + recency + decay + importance) → assemble cited context block within budget → optional LLM answer grounded on cited units.
3. **Consolidate** (debounced background job): generate **links** between related units, detect **contradictions**, promote **Crystals** (>=3 sources), update decay, run community detection (for UI clustering).
4. **WorkingMemory(date)** → pick most relevant units (community signal + recency + importance) → compact cited briefing string (`memory.md` style) the morning agent reads.
5. **Forgetting** → apply decay, archive units below threshold not recently reinforced; auditing via `jobs`.

## 7. Web UI (React + Vite + TS)
- **Graph** view: force-directed nodes=units, edges=links; color by type/status; community clusters; node importance.
- **Search**: hybrid (semantic + keyword) across units.
- **Unit detail**: content, citations (sources), links (in/out), version history, edit/merge/delete.
- **Traces**: conversation viewer; review extracted units (accept/discard/edit) — review queue.
- **Working Memory**: today's briefing.
- **Stats**: counts, token savings (dedup + context assembly), graph growth over time.
- **Settings**: provider config, thresholds.

## 8. API surface (REST) — summarized
`GET/POST /api/v1/*`: units (list/get/create/update/delete), links, search, recall, traces, sessions, sources, stats, working-memory, import/export (JSON + OKF bundle), jobs, health, settings.

## 9. MCP tools
`ingest`, `recall`, `search`, `save_unit`, `upsert_unit`, `link_units`, `get_graph`, `working_memory`, `forget`, `stats`, `curate`, `import`, `export`. Full schema in `docs/MCP_TOOLS.md`.

## 10. Testing
- **Unit tests** (vitest) for core: tokenizer, dedup/merge (with fake embedder), extraction parsing, context assembly budget, link generation, crystal promotion.
- **Integration tests** (vitest + better-sqlite3 in-memory/tmp): real DB + fake LLM dispatcher (deterministic, offline) covering ingest→recall→consolidate loop.
- **Server tests**: Fastify inject for API routes.
- **MCP tests**: in-memory client protocol tests.
- **e2e smoke**: docker compose up → health → ingest sample → query.

## 11. Deployment & OSS
- **Docker**: multi-stage build (core/db/server/static web), non-root, single container + optional compose (volume for `amem.db`).
- `.env.example`, docs for local dev (pnpm workspaces) and Docker.
- **CI** (GitHub Actions): typecheck, lint, test, build, docker build.
- `LICENSE` (MIT), `README.md`, `CONTRIBUTING.md`.
- Import/export guarantee = data sovereignty (JSON full export + OKF markdown bundle).

---

## 12. Self-audit (3 rounds)

### Round 1 — Requirements completeness & positioning
**Against the brief** (replace llm-wiki/obsidian-wiki; db+web+MCP+LLM; auto 整理/内容生成/连接生成; self-local-data; AI knowledge graph; non-markdown AI-first storage; LLM-as-librarian; snowball; context/hallucination/token-waste reduction; usable by Codex/Claude Code).
- ✅ All core asks mapped to concrete features (see sections 3–9).
- ✅ "连接生成" → auto link generation in Consolidate; UI exposes in/out links.
- ✅ "内容生成" → unit distillation, summary generation, working-memory briefing, optional grounded answers.
- ⚠️ **Token-waste reduction must be measurable.** → Add `stats` that reports: tokens saved by dedup (input avoided), and tokens delivered per recall vs raw. Stretch: report written by agent from graph (documented, post-MVP).
- ⚠️ **Human control over auto-extraction.** → Add explicit review workflow: extracted units start `status=pending`, web/API review (accept/edit/discard), plus `POST /units/:id/review`. Also manual merge/delete + version rollback.
- ✅ Hallucination: recall returns cited units; optional grounded answer; crystals require >=3 sources; contradiction edges flagged.
- ✅ Self-local-data & sovereignty: local sqlite + JSON full export + OKF bundle export/import.
- Decision: in-scope for this release = ingest→distill→dedup→link→recall→consolidate→working-memory + review + export. "Agent-written report from graph" = documented stretch goal.

### Round 2 — Architecture & tech-stack soundness
- ✅ Single-file SQLite = zero-ops self-host; WAL + `busy_timeout` for concurrent read processes.
- ⚠️ **Single-writer discipline**: `better-sqlite3` is sync/in-process. Server owns writes + background jobs in one process; MCP/CLI connect read-mostly and re-open per call. Document to avoid `SQLITE_BUSY`. Add `busy_timeout` + WAL.
- ⚠️ **Native build in Docker**: `better-sqlite3` needs build toolchain at image build time (python3, make, g++), or prebuilds. Multi-stage builder installs toolchain; runtime image is slim.
- ⚠️ **Scale boundary**: in-process cosine over JSON embeddings is fine to ~1e5 units (personal/team). Document; future: `sqlite-vec` (stretch).
- ✅ Provider-agnostic OpenAI-compatible LLM/embedding; offline deterministic embedder enables deterministic tests + no-network local mode.
- ✅ Hybrid retrieval (FTS5 + semantic), decay + recency + importance ranking.
- ⚠️ **Background scheduler**: keep in-process (debounced `setInterval`) audited by `jobs` table; no external cron dependency. Rate/token caps per plan.
- ⚠️ Web graph bundle weight (force-directed) — accept for dashboard; keep it lazy-loaded; lighter clustering fallback.
- Decision: all accepted; documented in `docs/ARCHITECTURE.md`.

### Round 3 — OSS-readiness & production
- ✅ Clean code: TypeScript strict, eslint + prettier, typed contracts/errors, no anys except boundary.
- ✅ Testability: fake (deterministic) LLM/embedding dispatcher for offline vitest unit + integration; server via Fastify inject; MCP via protocol client.
- ✅ Test scope: core (tokenizer, embedder, distill parse, dedup/merge, context-budget, link gen, crystal promotion, working-memory), db (repos + migrations), server (routes), mcp (tools), plus docker smoke.
- ⚠️ **Security**: API listens on `127.0.0.1` by default; optional `AMEM_API_TOKEN` bearer for HTTP/MCP when exposed; CORS restricted; `.env.example` only; no secrets committed; non-root container.
- ✅ Deployment: multi-stage Docker, non-root, `HEALTHCHECK`, compose with named volume; `.dockerignore`; pinned `pnpm-lock.yaml`.
- ✅ CI: typecheck → lint → test → build → docker build on PR/push.
- ✅ Docs: README (local + docker quickstart), docs/* (architecture, data model, API, MCP, OKF, deploy, dev), MIT LICENSE, CONTRIBUTING.
- Decision: accepted; incorporated into build tasks.

**Audit outcome**: plan approved with above refinements. Development proceeds with the agent team in §13.
