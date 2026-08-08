# Architecture

Amem is a **self-hosted, local-first knowledge & memory layer for AI agents**. It is a pnpm-monorepo of TypeScript packages: a graph-native store (SQLite), an LLM-driven curation core, a REST API, an MCP server, and a React web dashboard.

## High-level layout

```text
 agents (Codex / Claude Code / ...)
        │  MCP tools                     humans / other tools
        │  stdio │ streamable HTTP            │        │
        ▼        ▼                            ▼        ▼
   @amem/mcp  (MCP server)           @amem/server (REST, serves web static)
        └─────────────┬────────────────────────┘
                      ▼
        @amem/core  (engines: distill, dedup, link, recall, consolidate, working-memory)
                      ▼
        @amem/db    (SQLite graph store, single local file)
                      │
              amem.db (yours — local, exportable)
```

## Packages

| Package | Dir | Responsibility |
|---------|-----|----------------|
| `@amem/core` | `packages/core` | Domain types, config, embedder (API/offline), LLM client, distillation, dedup/merge, link generation, recall & context assembly, consolidation/jobs, working memory, OKF export |
| `@amem/db` | `packages/db` | SQLite schema + migrations, `Storage` implementation (repositories), JSON vectors |
| `@amem/server` | `packages/server` | Fastify REST API, static hosting of the web build, background consolidation scheduler, import/export, health |
| `@amem/mcp` | `packages/mcp` | Model Context Protocol server exposing Amem tools (stdio + streamable HTTP) |
| `@amem/web` | `apps/web` | React dashboard: graph viz, search, traces, review queue, stats, working memory |

## Layering & contracts

- `packages/core/src/domain.ts` — the single source of truth for the domain model (`Unit`, `Link`, `Trace`, `Source`, `AmemService`, …).
- `packages/core/src/store.ts` — the `Storage` interface. Core engines depend only on it; `@amem/db` implements it. This keeps storage swappable and core testable with an in-memory fake.
- `packages/core/src/service.ts` — `createService(config, storage, deps?)` wires engines + storage into the full `AmemService`; `server` and `mcp` both consume this.

Dependency direction: `server`/`mcp` → `core` + `db`; `db` → `core` (types only). No cycles.

## Data flow

1. **Ingest** — raw material (a transcript, doc, or note) becomes a `Trace`; distillation extracts atomic `Unit`s (typed: fact/decision/plan/…), deduplicated against existing units by embedding similarity, stored with citations to `Source`s.
2. **Link** — consolidation generates typed `Link` edges between related units (cross-references) and detects contradictions.
3. **Recall** — a query is hybrid-scored (semantic + keyword + recency + importance + decay) and assembled into a compact, cited context block within a token budget. **Search** uses the same hybrid scorer with field-weighted keyword matching (title > tags > summary > body head; CJK-character aware, optional `fullText` body scan) plus filters (`type`/`category`/`tag`/`status`), and returns the matched `terms` for UI highlighting.
4. **Consolidate** — background, debounced job: promotes `Crystal`s (>=3 sources), applies decay/forgetting, updates importance, records a `Job` audit row.
5. **Working memory** — a compact daily briefing of the most relevant units (attention prefetch for an agent's morning session).

## Layered memory (L0–L3)

Amem stores knowledge in four layers so that an agent gets the **gist first and
precision on demand** — the same trade-off TencentDB-Agent-Memory makes between
raw fidelity and context cost:

| Layer | What it holds | Writes | Reads |
|-------|---------------|-------|-------|
| L0 | Raw material: `Trace` (transcript/doc/ingest) + `Source` (file with content hash) | `ingest`, `import_*` | drill-down, provenance, audit |
| L1 | Atomic `Unit`s (fact/decision/plan/procedure/preference/concept/lesson/question), deduped, cited, typed, decayed | distill (LLM or heuristic), `save_unit` | `recall`, search, graph |
| L2 | `Scenario` — LLM-consolidated narrative block per project/topic tag, compressing many L1 units with `sourceUnitIds` provenance | `refresh_layers` | layered recall, UI Scenarios tab |
| L3 | `Persona` — short (<2000 chars) stable owner profile: identity, preferences, working style, recurring goals. One per workspace | `refresh_layers` | layered recall bootstrap, working memory |

### Distillation (L1 → L2 → L3)

- `groupUnitsByTag` clusters reviewed/active L1 units by tag (tags with ≥2 units
  become scenario candidates; an explicit `tags` list forces groups).
- An LLM (when configured) rewrites each group into a compact markdown
  narrative, merging new units into the existing scenario story
  (create / integrate / rewrite, version + `lastConsolidatedAt` bump).
- Without an LLM, deterministic heuristics produce the same shapes so the
  pipeline works offline and stays testable.
- The persona is distilled from the scenario list + high-importance units,
  idempotently upserted (one row per workspace, versioned).
- Never throws on LLM failure — always falls back.

### Layered recall strategy

`recall_layered` / `POST /recall/layered` assembles context in token-efficiency
order under one budget (default `thresholds.recallBudget`):

1. **L3 persona** (~15% slice) — cheap long-term identity/profile.
2. **L2 scenarios** (~35%) — keyword-matched compact blocks; a unit already
   covered by a selected scenario (`sourceUnitIds`) is **not repeated** at L1.
3. **L1 units** (~50%) — hybrid-scored (semantic + keyword + recency + decay +
   importance) precise facts with citations, spill over whatever remains.

Result: the agent starts from the distilled picture, then gets exactly the
precise facts it has budget for — fewer tokens, less repetition, higher
accuracy than dumping raw history.

### Assets (自动沉淀资产)

Portable, framework-agnostic memory artifacts decoupled from any agent:

| Kind | Source | Shape |
|------|--------|-------|
| `skill` | procedure/lesson/preference/decision units | name, description, trigger, steps, validation, tags (JSON `content` + markdown `body`) |
| `wiki` | docs/imports | structured page per imported doc source uri |
| `codegraph` | code imports | module/symbol map (see importers) |
| `prompt` | manual | reusable prompt template |

All extractors are idempotent (upsert by name, provenance via `sourceUnitIds`):

- `extract_skills` / `POST /skills/extract` — distills Skill assets from
  procedure/lesson/preference/decision units, with an LLM pass over fresh
  units and per-unit heuristic fallback.
- `extract_codegraph` / `POST /assets/extract/codegraph` — aggregates
  `labels.kind=module` units into a `codegraph:<scope>` asset per top-level
  directory, with symbols expanded from `part_of` links.
- `extract_wiki` / `POST /assets/extract/wiki` — groups doc-sourced units by
  their source uri (`*.md` / `*.markdown` / `*.txt`) into one wiki asset per
  file.
- `autoPrecipitate` / `POST /layers/precipitate` — runs refresh layers +
  skills + codegraph + wiki in one pass; the scheduler triggers it on
  alternating cycles with `curate(fast)`. When `AMEM_AUTO_PRECIPITATE` is set
  (`fast`/`auto`/`full`, default `off`), every successful ingest also triggers
  a precipitation pass (throttled by `AMEM_AUTO_PRECIPITATE_MIN_INTERVAL_MS`,
  default 60s) so new conversations become scenarios/skills/wiki/codegraph
  automatically. `fast` is heuristic-only (no LLM cost).

Assets have a lifecycle `draft → reviewed → published → archived` for human
review before agents reuse them. Agents receive assets through the routed
surface:

- `list_equipped` / `GET /api/v1/assets/equipped?agent=<name>` — returns only
  `published` assets whose `visibility` is `workspace` (any agent) or
  `private` bound to that agent via `bound_agents`. Agents never see drafts or
  other agents' private assets.
- `call_asset` / `POST /api/v1/assets/:id/call` — returns the asset body
  truncated to a token `budget` (`[truncated: …]` marker, `usedTokens`), rejects
  unpublished/unbound assets with `FORBIDDEN`, and records an `asset_call`
  activity for audit.

The MCP surface (`tools/list` → `tools/call`) maps onto these same
`listEquipped`/`callAsset` service methods, so Codex and Claude Code can
discover and invoke skills/wiki/codegraph through the standard MCP protocol.

### Importers (冷启动友好)

- `importDirectory` — docs folder (markdown/txt) → traces + distilled units.
- `importCodebase` — code files → module + symbol units with stable ids
  (`mod_<sha1>` / `sym_<sha1>`), `part_of` links, and a light CodeGraph.
  Stable ids make re-imports idempotent.
- `importSessions` — Codex/Claude/generic JSONL, JSON, or plain-text
  transcripts (`user:`/`assistant:` prefixes) → traces + distilled units.

Stable ids + dedup mean a new agent team can import its existing docs, code,
and chat history once and start from accumulated experience instead of
scratching from zero.

## Storage notes

- Single local SQLite file (`AMEM_DB_PATH`, default `./data/amem.db`), WAL mode, `busy_timeout`. One process owns writes (the server); MCP/CLI connect read-mostly.
- Embeddings stored as JSON `float[]`; similarity (cosine) computed in-process — fine to ~1e5 units for personal/team scale. (Stretch: `sqlite-vec`.)
- Data sovereignty: full JSON export + Open Knowledge Format (OKF) markdown bundle export at any time.
