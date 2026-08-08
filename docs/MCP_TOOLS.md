# MCP tools

`@amem/mcp` exposes Amem as a Model Context Protocol server, so Codex, Claude Code, Cursor, and other MCP clients can **write to and read from** the knowledge graph.

Transports: **stdio** (default, for local agents) and **Streamable HTTP** (for remote).

## Tools

| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `ingest` | `{ title, content, contentType?, sourceUri?, sessionId?, extract?, autoLink?, autoReview? }` | `IngestResult` | Save a trace + distill atomic units (with dedup). |
| `recall` | `{ query, tokenBudget?, topK?, includeBody? }` | `RecallResult` | Assemble a compact, cited context block for prompt injection. |
| `recall_layered` | `{ query, tokenBudget?, topK?, includeBody? }` | `LayeredRecallResult` | L0-L3 layered recall: persona + scenario blocks first, then precise units, budget-gated (less context, more signal). |
| `search` | `{ query, limit?, offset? }` | `SearchResult` (includes `total`) | Hybrid keyword+semantic search; paginate with `limit`/`offset`. |
| `save_unit` | `{ unit: NewUnit }` | `Unit` | Manually write a knowledge unit (procedures, plans, facts). |
| `get_unit` | `{ id }` | `Unit` | Read a single unit. |
| `update_unit` | `{ id, patch, reason? }` | `Unit` | Edit a unit (records a version). |
| `list_units` | `{ type?, status?, tag?, limit? }` | `UnitSummary[]` | Browse units. |
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
| `curate` | `{ preset? }` | `CurateReport` | Run consolidation (link, promote crystals, decay). |
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
