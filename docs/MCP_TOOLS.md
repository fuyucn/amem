# MCP tools

`@amem/mcp` exposes Amem as a Model Context Protocol server, so Codex, Claude Code, Cursor, and other MCP clients can **write to and read from** the knowledge graph.

Transports: **stdio** (default, for local agents) and **Streamable HTTP** (for remote).

## Tools

| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `ingest` | `{ title, content, contentType?, sourceUri?, sessionId?, extract?, autoLink?, autoReview?, zone? }` | `IngestResult` | Save a trace + distill atomic units (with dedup). `zone` (id/slug) partitions the extracted units. |
| `recall` | `{ query, tokenBudget?, topK?, includeBody?, zone?, crossZone? }` | `RecallResult` | Assemble a compact, cited context block for prompt injection. `zone` pins one partition; `crossZone` skips auto-routing and searches every accessible zone. |
| `recall_layered` | `{ query, tokenBudget?, topK?, includeBody?, zone?, crossZone? }` | `LayeredRecallResult` | L0-L3 layered recall: persona + scenario blocks first, then precise units, budget-gated (less context, more signal). |
| `search` | `{ query, limit?, offset?, zone?, crossZone? }` | `SearchResult` (includes `total`) | Hybrid keyword+semantic search; paginate with `limit`/`offset`; `zone` restricts to one partition. |
| `save_unit` | `{ unit: NewUnit }` | `Unit` | Manually write a knowledge unit (procedures, plans, facts). Set `unit.zoneId` (id/slug) to partition it. |
| `get_unit` | `{ id }` | `Unit` | Read a single unit. |
| `update_unit` | `{ id, patch, reason? }` | `Unit` | Edit a unit (records a version). |
| `list_units` | `{ type?, status?, tag?, zone?, limit? }` | `UnitSummary[]` | Browse units, optionally filtered by zone (id/slug). |
| `link_units` | `{ sourceUnitId, targetUnitId, relation, reason? }` | `Link` | Manually cross-reference two units. |
| `prune_links` | `{ maxPerUnit?, dryRun? }` | `{ examined, kept, deleted }` | Trim auto links so every unit stays ≤ `maxPerUnit` degree (default 8); `dryRun: true` previews without deleting. |
| `get_graph` | `{ includeClusters? }` | `Graph` | Fetch nodes + edges (for graph-aware reasoning) |
| `working_memory` | `{ date?, budget? }` | `WorkingMemory` | Today's compact briefing (attention prefetch). |
| `list_scenarios` | `{ tag?, status?, limit? }` | `Scenario[]` | Browse L2 consolidated knowledge blocks. |
| `get_scenario` | `{ id }` | `Scenario` | Read one L2 block (drill into `sourceUnitIds` for raw units). |
| `refresh_layers` | `{ tags?, forcePersona?, maxScenarios?, mode? }` (`mode`: `fast` = heuristics only, `auto` = LLM for large groups, `full` = LLM everywhere) | `LayerRefreshResult` | Run L2/L3 distillation now (default `auto`; never throws — falls back to deterministic heuristics). |
| `get_persona` | `{}` | `Persona \| null` | Read the workspace L3 profile (cheap context bootstrap). |
| `list_assets` | `{ kind?, status?, limit? }` | `Asset[]` | Browse portable assets (skill/wiki/codegraph/prompt). |
| `get_asset` | `{ id }` | `Asset` | Read one asset for routing/reuse. |
| `save_asset` | `{ asset: NewAsset }` | `Asset` | Manually write/review an asset. |
| `list_equipped` | `{ agent }` | `Asset[]` | Assets routed to this agent (published + workspace-visible or bound via `boundAgents`). |
| `route_skills` | `{ task, agent?, kind?, limit? }` | `AssetRouteResult` | Rank published assets (skill/wiki/codegraph/prompt) for a task description; keyword-overlap scoring with trigger bonus, agent-scope filtered. |
| `call_asset` | `{ id, agent?, budget? }` | `AssetCallResult` | Invoke an asset body budget-gated (`usedTokens`/`truncated`); `FORBIDDEN` when unpublished/unbound. |
| `extract_skills` | `{ limit?, includePending? }` | `SkillExtractResult` | Distill procedure/lesson/preference/decision units into reusable Skill assets (idempotent by name). |
| `extract_codegraph` | `{ limit? }` | `AssetExtractResult` | Aggregate module units into `codegraph:<scope>` assets (idempotent, zero-LLM). |
| `extract_wiki` | `{ limit? }` | `AssetExtractResult` | Group doc-sourced units by source uri into wiki assets (idempotent, zero-LLM). |
| `precipitate` | `{ mode?: 'fast'\|'auto' }` | `PrecipitateResult` | One-shot auto-precipitation: refresh layers + skills + codegraph + wiki. |
| `import_directory` | `{ path, extensions?, extract? }` | `ImportSourcesResult` | Cold-start: import a docs folder → traces + distilled units. |
| `import_codebase` | `{ path, extensions?, maxFiles? }` | `ImportSourcesResult` | Cold-start: import a codebase → module/symbol units + `part_of` CodeGraph. |
| `import_sessions` | `{ path, format?, sessionLabel?, extract? }` | `ImportSourcesResult` | Cold-start: import Codex/Claude JSONL/JSON/TXT transcripts. |
| `review_unit` | `{ id, action }` | `Unit \| null` | Accept/discard auto-extracted units. |
| `forget` | `{ id, reason }` | `{}` | Remove a unit. |
| `curate` | `{ preset? }` | `CurateReport` | Maintenance pass. `fast`: consolidation only (link, promote crystals, decay). `full`: also LLM-classify unclassified units (and compress long bodies — see `refine_units`); report includes `classified`/`examined`/`viaRules`/`viaLlm`. |
| `stats` | `{}` | `Stats` | Counts + token savings metrics. |
| `export` | `{}` | `ExportBundle` | Full JSON export (data sovereignty). |
| `import` | `{ bundle }` | `ImportResult` | Restore a bundle. |
| `health` | `{}` | `{ ok, version, embeddingMode }` | Liveness. |

## Configuration examples

**Claude Code** `.mcp.json`:
```json
{ "mcpServers": { "amem": { "command": "node", "args": ["/path/to/amem/packages/mcp/dist/cli.js"] } } }
```

**Codex / Cursor** — point the MCP client at the same command, or use the Streamable HTTP URL `http://127.0.0.1:8321/mcp` (with `Authorization: Bearer <token>` if configured).

> Tip: at the start of a session, call `working_memory`, `get_persona`, and
> `recall_layered "active project"` to warm context; at the end of a session
> call `ingest` with the transcript and `refresh_layers` to consolidate into
> L2/L3. Amem keeps the knowledge base snowballing between tools.

## Zone scoping

Amem partitions knowledge into **zones** under a workspace (`personal` /
`shared` / `project` / `inbox`). See `docs/ZONES.md` for the full model.

- **Per-call**: pass `zone` (id or slug) to `ingest`, `save_unit`,
  `list_units`, `recall`, `recall_layered`, `search`; pass `crossZone: true`
  to `recall`/`recall_layered`/`search` to search every accessible zone.
- **Session-wide (stdio)**: set `AMEM_WORKSPACE` (default `personal`) and
  `AMEM_ZONE` (zone id/slug) when launching the MCP server. With `AMEM_ZONE`
  set, **every** tool is scoped to that zone — reads are filtered at the
  storage layer (no per-tool params needed for `get_graph`,
  `working_memory`, `get_unit`, `list_scenarios`, `stats`, `activity`,
  `curate`, …) and new writes without an explicit `zone` land in it.
  A misconfigured `AMEM_ZONE` fails at startup instead of silently widening
  access.
- **Over HTTP**: the server honors `x-amem-zone` per request; an
  inaccessible/unknown zone is rejected with `403`.

Example (project-scoped agent):
```sh
AMEM_WORKSPACE=acme AMEM_ZONE=backend node packages/mcp/dist/cli.js
```
