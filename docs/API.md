# REST API

Base: `http://<host>:<port>/api/v1` (default `127.0.0.1:8321`).

If `AMEM_API_TOKEN` is set, every `/api/*` request must include `Authorization: Bearer <token>`.

All request/response bodies are JSON. Errors use `{ "error": { "code", "message", "details? } }` with an appropriate HTTP status (`404` NOT_FOUND, `400` VALIDATION, `409` CONFLICT, `401` UNAUTHORIZED, `429` RATE_LIMITED, `503` BUSY/PROVIDER, `500` INTERNAL).

## Endpoints

| Method | Path | Body / Query | Returns |
|--------|------|--------------|---------|
| GET | `/health` | – | `{ ok, version, embeddingMode }` |
| GET | `/admin/db-health` | Bearer PAT/admin | `{ ok, status, journal, units, hint }` — use instead of host `sqlite3` while Docker runs |
| POST | `/ingest` | `IngestInput` `{ title, content, contentType?, sourceUri?, sessionId?, extract?, autoLink?, autoReview?, zone? }` — `zone` is a zone id/slug to partition extracted units | `IngestResult` `{ trace, units, deduplicated, tokensSavedByDedup }` |
| POST | `/recall` | `{ query, tokenBudget?, topK?, includeBody?, zone?, crossZone? }` | `RecallResult` `{ query, budget, usedTokens, items[{unit,score,reason,citations}], text, grounded }` — `zone` pins one partition; `crossZone` skips auto-routing and searches every accessible zone |
| POST | `/recall/layered` | `{ query, tokenBudget?, topK?, includeBody?, zone?, crossZone? }` | `LayeredRecallResult` — L3 persona + L2 scenarios + L1 units, token-budgeted (see ARCHITECTURE.md) |
| GET | `/search?q=&limit=&offset=&type=&category=&tag=&status=&fullText=&zone=&crossZone=` | – | `SearchResult` — keyword+semantic hybrid; `limit`/`offset` paginate (`total` returns the full match count before paging); optional filters `type` (`fact`/`decision`/…), `category` (label), `tag` (exact), `status` (`pending`/`reviewed`/…), `fullText=1` (match inside full body beyond title/summary/tags); `zone` restricts to one partition; each item includes matched `terms` for UI highlighting |
| GET | `/units?type=&status=&tag=&zone=&limit=&offset=` | – | `UnitSummary[]` — `zone` (id/slug) filters by partition |
| POST | `/units` | `{ unit: NewUnit, zone? }` | `Unit` — `zone` routes the write into a partition |
| GET | `/zones` | – | `Zone[]` — zones the caller can access (with member/unit counts) |
| POST | `/zones` | `{ slug, name, kind?, visibility?, description? }` | `Zone` — create a project zone |
| PATCH | `/zones/:id` | `{ name?, description?, visibility? }` | `Zone` |
| DELETE | `/zones/:id` | – | `204` (non-empty zones return `409`) |
| GET | `/zones/:id/members` | – | `ZoneMember[]` |
| POST | `/zones/:id/members` | `{ userId, role: 'owner'\|'editor'\|'reader' }` | `ZoneMember` |
| DELETE | `/zones/:id/members/:userId` | – | `204` |
| POST | `/zones/recompute` | – | `{ updated, skippedOffline }` — recompute zone embedding centroids |
| POST | `/zones/proposals` | – | `ZoneProposal[]` — centroid-cluster proposals for new zones (human-confirmed) |
| POST | `/units/:id/zone` | `{ zoneId, zoneSlug? }` | `{ ok, zoneSlug }` — move a unit to another partition |
| GET | `/units/:id` | – | `Unit` |
| POST | `/units` | `{ unit: NewUnit }` | `Unit` |
| PATCH | `/units/:id` | `{ patch, reason? }` | `Unit` |
| DELETE | `/units/:id?reason=` | – | `204` |
| POST | `/units/:id/review` | `{ action: 'accept'\|'discard' }` | `Unit \| null` |
| GET | `/graph?clusters=1` | – | `Graph` `{ nodes, links, clusters? }` |
| GET | `/links/:unitId` | – | `Link[]` |
| POST | `/links` | `{ sourceUnitId, targetUnitId, relation, reason?, auto? }` | `Link` |
| GET | `/traces` | – | `Trace[]` |
| GET | `/traces/:id` | – | `Trace` |
| DELETE | `/traces` | `{ ids?: string[], before?: ISO, all?: boolean }` — admin scope only, one filter required | `{ ok, deleted }` — audit-hygiene purge (e.g. probe/test noise); never touches units |
| GET | `/working-memory?date=&budget=` | – | `WorkingMemory` |
| GET | `/scenarios?tag=&status=&limit=` | – | `Scenario[]` (L2 blocks, newest first) |
| GET | `/scenarios/:id` | – | `Scenario` |
| POST | `/layers/refresh` | `{ tags?, forcePersona?, maxScenarios?, mode? }` where `mode` ∈ `fast` (heuristics only, instant) / `auto` (LLM for large groups) / `full` (LLM everywhere) | `LayerRefreshResult` `{ scenariosCreated, scenariosUpdated, personaUpdated, unitsCovered }` |
| GET | `/persona` | – | `Persona \| null` (L3 profile, one per workspace) |
| GET | `/assets?kind=&status=&limit=` | – | `Asset[]` (skill/wiki/codegraph/prompt) |
| GET | `/assets/equipped?agent=` | bearer | `Asset[]` — published + visible/bound for that agent |
| GET | `/assets/:id` | – | `Asset` |
| POST | `/assets` | `{ asset: NewAsset }` | `Asset` |
| PATCH | `/assets/:id` | `{ patch, reason? }` | `Asset` |
| POST | `/assets/:id/call` | `{ agent?, budget? }` | `{ assetId, kind, body, usedTokens, truncated }` — budget-gated body, `FORBIDDEN` when unpublished/unbound |
| DELETE | `/assets/:id` | – | `204` |
| POST | `/skills/extract` | `{ limit?, includePending? }` | `SkillExtractResult` `{ created, updated, assets }` |
| POST | `/assets/extract/codegraph` | `{ limit? }` | `AssetExtractResult` — idempotent `codegraph:<scope>` assets from module units |
| POST | `/assets/extract/wiki` | `{ limit? }` | `AssetExtractResult` — idempotent wiki assets grouped by source uri |
| POST | `/layers/precipitate` | `{ mode?: 'fast'\|'auto' }` | `PrecipitateResult` — refresh layers + skills + codegraph + wiki in one pass |
| POST | `/import/directory` | `ImportDirInput` `{ path, extensions?, extract? }` | `ImportSourcesResult` |
| POST | `/import/pdf` | `ImportPdfInput` `{ filename, contentBase64, extract?, zone?, maxBytes? }` — base64 PDF, parsed in-process (unpdf), chunked → ingest; when the extracted text layer is below `ocr.minChars` (default 60) and an OCR provider is configured, pages are rendered to images and OCR'd, returning `ocrPages` | `ImportSourcesResult` |
| POST | `/ingest/file` | `{ filename, contentBase64, extract?, zone? }` — browser-friendly single-file import: `.pdf` dispatches to the PDF pipeline (OCR fallback for scans), md/txt are ingested as a text trace and distilled into units. Returns `ImportSourcesResult` | `ImportSourcesResult` |
| POST | `/import/codebase` | `ImportCodebaseInput` `{ path, extensions?, maxFiles? }` | `ImportSourcesResult` — module + symbol units + `part_of` links |
| POST | `/import/sessions` | `ImportSessionsInput` `{ path, format?: 'auto'\|'jsonl'\|'json'\|'txt', sessionLabel?, extract? }` | `ImportSourcesResult` |
| POST | `/curate` | `{ preset?: 'fast'\|'full' }` | `CurateReport` |
| GET | `/stats` | – | `Stats` |
| GET | `/export` | – | `ExportBundle` (JSON) |
| POST | `/import` | body: `ExportBundle` | `ImportResult` |
| GET | `/export/okf` | – | `{ files: Record<string,string> }` (OKF bundle) |

Types come from `packages/core/src/domain.ts`.

## AI providers (Settings)

Providers are instance-global OpenAI-compatible endpoints managed from the
Settings UI (or this API). Chat and embeddings can point at **different**
endpoints: set `embeddingModel` / `embeddingBaseUrl` / `embeddingApiKey` when
the chat provider has no `/embeddings` route (e.g. some gateways), and the
embedder falls back to the chat `baseUrl` / `model` / `apiKey` when unset.

| Method | Path | Body / Query | Returns |
|--------|------|--------------|---------|
| GET | `/providers` | – | `AiProvider[]` — masked: `hasKey`, `hasEmbeddingKey` replace raw keys |
| POST | `/providers` | `AiProviderInput` `{ name, kind, baseUrl, model, apiKey?, embeddingModel?, embeddingBaseUrl?, embeddingApiKey?, isActive? }` | `AiProvider` |
| PUT | `/providers/:id` | `AiProviderInput` (partial OK) | `AiProvider` |
| DELETE | `/providers/:id` | – | `204` |
| POST | `/providers/:id/activate` | – | `AiProvider` (becomes the active LLM provider) |
| POST | `/providers/:id/test` | – | `ProviderTestResult` `{ ok, latencyMs, error? }` |
| GET | `/ai/status` | – | `{ active: AiProvider \| null, env: EnvLlm \| null, mode: 'provider'\|'env'\|'mock', embedding: { mode: 'api'\|'offline' } }` |
| GET | `/ocr/settings` | – | `OcrSettings \| null` — masked: `hasKey` / `keyPrefix` replace the raw key |
| PUT | `/ocr/settings` | `OcrSettingsInput` `{ baseUrl, model, apiKey?, minChars? }` | `OcrSettings` (admin-scoped, AES-256-GCM key at rest) |
| DELETE | `/ocr/settings` | – | `{ settings: null }` |

API keys are encrypted at rest, never serialized in responses, and logs are
masked. Deleting the active provider resets Amem to the offline embedder and
`mock` chat mode until another provider is activated.

OCR settings are the vision endpoint used for scanned PDFs (`/import/pdf`).
Resolution priority at import time is env (`AMEM_OCR_*`) → DB (Settings UI /
`/ocr/settings`) → none; when none is configured, scanned PDFs are skipped
(`units: 0`). Omitting `apiKey` on update keeps the stored key.


## Auth & workspaces (MVP)

- `POST /api/v1/auth/bootstrap` — first admin (only if no users)
- `POST /api/v1/auth/login` — email/password → PAT
- `GET /api/v1/me` — principal + workspaces
- `GET/POST /api/v1/workspaces` — list/create (`X-Amem-Workspace: <slug>` selects active ws)
- `GET/POST/DELETE /api/v1/auth/tokens` — manage PATs
- `GET/DELETE /api/v1/auth/sessions` — list/revoke active login + OAuth sessions
- Header `Authorization: Bearer amem_pat_...`
- Header `X-Amem-Workspace: personal|acme`
- Header `X-Amem-Zone: backend|z_...` — per-request zone scope (id or slug);
  an inaccessible/unknown zone returns `403` (no silent fallback)
- Storage enforces `workspace_id` isolation

Zones (partitions) sit under workspaces: see `docs/ZONES.md` for the
partition model, ACL, auto-routing, and the `AMEM_WORKSPACE` / `AMEM_ZONE`
environment variables used by MCP/stdio clients.


## OAuth / MCP discovery

- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource[/mcp]`
- `POST /oauth/register` (DCR public clients)
- `GET/POST /oauth/authorize` (PKCE S256)
- `POST /oauth/token` / `POST /oauth/revoke`
- Refresh tokens rotate on every use; a replayed refresh token revokes its whole token family (`oauth_refresh_reuse` audit event).
- HTTP MCP: `POST/GET /mcp` (OAuth Bearer or PAT)
