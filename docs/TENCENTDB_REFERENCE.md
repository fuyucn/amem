# TencentDB-Agent-Memory reference analysis

Reviewed: `TencentCloud/TencentDB-Agent-Memory` (README + memory/session/asset
modules) and mapped against Amem's existing design. Conclusion: the project
**validates Amem's layering direction** and contributed concrete, adoptable
mechanics. This page records what was adopted, what was deliberately left out,
and why.

## What we adopted

| TencentDB-Agent-Memory idea | Amem implementation |
|------------------------------|---------------------|
| **L0 raw ↔ L1 processed separation** | L0 = `Trace`/`Source`, L1 = atomic `Unit`s with citations (`docs/DATA_MODEL.md`) |
| **L2 scenario consolidation** | `Scenario` rows + `refresh_layers`: LLM merge-or-rewrite per tag group, provenance via `sourceUnitIds` |
| **L3 persona (stable, short profile)** | `Persona` row (one per workspace, ≤2000 chars, versioned) |
| **Layered recall (gist-first, budget-gated)** | `recall_layered`: persona 15% → scenarios 35% → units 50%, covered units excluded from L1 |
| **Automatic asset precipitation** | `extract_skills` → `Asset` rows (`skill`/`wiki`/`codegraph`/`prompt`), idempotent by name, `draft→published` review lifecycle |
| **Agent-framework decoupling / portability** | Assets are plain rows + OKF/JSON export; any MCP agent (Codex, Claude Code) reads them |
| **Tools: list + call routing** | `list_equipped` (`visibility` + `bound_agents` filter) + `call_asset` (budget-gated body, `asset_call` activity) + `route_skills` (rank published assets for a task description, `POST /api/v1/assets/route`) — maps to TencentDB's tools routing |
| **Turn-end auto-capture** | Stop hook (`hooks/amem-stop.sh`) ingests each turn; `AMEM_AUTO_PRECIPITATE` makes every ingest also auto-precipitate assets |
| **Cold-start import** | `import_directory` / `import_codebase` (stable `mod_/sym_` ids → idempotent CodeGraph) / `import_sessions` (JSONL/JSON/TXT) |
| **Accuracy guardrails** | dedup/merge by embedding, `sourceUnitIds` provenance, version history, citations in recall output; recall suppresses near-duplicates (normalized-title exact match or embedding cosine ≥ 0.92, reports `deduplicated`) and demotes unreviewed `pending` units (−0.12 score) |

## Why Amem differs

- **Single local SQLite file** instead of a managed vector DB: Amem is
  self-hosted, local-first, and runs with one `docker compose up`. TencentDB is
  a cloud database service; the *agent-memory* pattern transfers, the hosting
  model does not.
- **Deterministic offline fallbacks**: every LLM step (scenario merge, persona,
  skill extraction, distillation) degrades to heuristics when no provider is
  configured, so Amem works air-gapped and is testable without network.
- **Auto-precipitation is opt-in and throttled**: `AMEM_AUTO_PRECIPITATE=fast`
  (default `off`) runs heuristic-only precipitation after each ingest, with a
  `minIntervalMs` throttle so background cost stays bounded; `auto`/`full`
  additionally call the LLM.
- **Workspace isolation at the storage layer**: Amem's `scenarios`/`personas`/
  `assets` tables carry `workspace_id` (like units/traces), so company A,
  company B, and personal data never mix even in one DB.
- **Token savings are surfaced**: recall reports `usedTokens` vs `budget`;
  dedup reports `tokensSavedByDedup`; the Dashboard shows cumulative savings —
  the value of layering is measurable, not assumed.

## Not adopted (deliberately)

- **Deep per-tenant routing/tiers** — out of scope for a personal/team
  self-hosted memory; Amem keeps one instance + workspaces.
- **Heavy evaluation harness** — Amem keeps a small `tools/smoke.mjs` +
  per-package vitest suites; OmniMemEval-style benchmarking is tracked in
  `docs/BENCHMARK.md`.

## Gaps found vs TencentDB-Agent-Memory (and how we closed them)

- **Asset version chain** — Tencent `skill-versioning.ts` keeps every skill
  version (head + COS version dirs, unchanged content returns
  `IdempotentNoOpError`). Amem only bumped an integer `version` with no
  recoverable history. **Decision**: added an `asset_versions` snapshot table
  (migration 10, `SCHEMA_VERSION=11`). `snapshotAssetVersion()` writes an
  immutable `Omit<Asset,'id'>` snapshot before any content-bearing update;
  `listAssetVersions()` returns newest-first. Content-only updates fork the
  chain; provenance-only growth keeps the version number stable; unchanged
  content is a true no-op (no version bump, no snapshot) — mirrors
  `IdempotentNoOpError`.
- **Workspace header silently fell back** — an explicit `X-Amem-Workspace`
  targeting a forbidden/unknown workspace used to fall back to
  `allowed[0]` instead of failing. **Decision**: `resolveRequestAuth()` in
  `packages/server/src/auth.ts` now distinguishes explicit header from default
  slug and returns **403 FORBIDDEN**; `statusFor('FORBIDDEN')` → 403 (was
  500). Covered for legacy static token, anonymous, legacy token, OAuth, and
  PAT paths.
- **Versions were invisible to agents/UI** — **Decision**: added
  `GET /assets/:id/versions` REST route, `list_asset_versions` MCP tool, and
  `listAssetVersions()` on the HTTP backend, so Codex/Claude Code can audit
  and restore any skill/wiki/codegraph version.
- **No task→asset routing** — `list_equipped` only answered "what do I have";
  nothing answered "what should I use for this task". **Decision**: added
  `routeAssets()` (keyword-overlap scoring over name/description/trigger/tags/
  body, trigger bonus, published-only, agent-scope filtered) behind
  `POST /api/v1/assets/route` and the `route_skills` MCP tool; activity records
  `asset_route` with the ranked top names.
- **Recall could surface paraphrase duplicates** — several units saying the
  same thing inflated context and invited contradiction. **Decision**: recall
  and layeredRecall now suppress near-duplicates of an accepted unit
  (normalized-title exact match, or embedding cosine ≥ 0.92) and report a
  `deduplicated` count; unreviewed `pending` units are demoted (−0.12 score)
  so trusted knowledge wins ties.

Both changes are regression-tested (db version-chain round-trip, core
`extractSkills` idempotent no-op + snapshot-on-change, server 403 isolation +
`/assets/:id/versions` end-to-end, core route + recall-quality suites, server
`/assets/route` end-to-end). Full suite: **159 tests green** (web 8 / core 79 /
db 19 / mcp 6 / server 47).

## Suggested reading order

1. `docs/ARCHITECTURE.md` — L0–L3 layering + recall strategy (this repo).
2. `packages/core/src/{layers,skills,importer,layeredRecall}.ts` — the adopted
   mechanics, each unit-tested in `packages/core/test/`.
3. TencentDB-Agent-Memory README — the original framing of memory layers,
   session capture, and asset routing.
