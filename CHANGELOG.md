# Changelog

All notable changes to Amem are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- CI: GitHub Actions upgraded to `checkout@v7` / `setup-node@v7` /
  `pnpm/action-setup@v6`; new `release.yml` publishes a GHCR image and a
  source archive to GitHub Releases on every `v*` tag.
- Search pagination: `GET /api/v1/search` accepts `offset`, returns `total`;
  the Web UI shows "X more" and a **Load more** button (20/page).
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates, CI badge.
- `docs/OPERATIONS.md` — backup/restore, upgrade, monitoring, troubleshooting.

## [0.1.0] — 2026-08-08

Initial self-hosted release.

### Added

- AI-first knowledge graph storage: Trace → Unit → Crystal consolidation,
  8 unit types, typed links, version history, decay/forgetting.
- Hybrid retrieval: FTS5 keyword + embedding similarity, decay + recency +
  importance ranking, token-budgeted cited context blocks, working memory
  briefing, layered recall.
- Code-symbol-aware ranking (`AMEM_CODE_SYMBOL_PENALTY`,
  `AMEM_KNOWLEDGE_BOOST`) and keyword-first hybrid search with CJK-aware
  tokenization, field weighting (title/tags/summary/body), filters
  (`type`/`category`/`tag`/`status`/`fullText`), and UI `<mark>` highlighting.
- Auto-organization: distillation, dedup/merge, link generation, contradiction
  detection, crystal promotion, auto asset precipitation
  (`AMEM_AUTO_PRECIPITATE=off|fast|auto|full`).
- MCP server (stdio + Streamable HTTP) with `ingest`, `recall`, `search`,
  `save_unit`, `working_memory`, `curate`, `stats`, graph tools and more.
- REST API: full CRUD, search, recall, traces, review, import/export
  (JSON + OKF markdown bundle), stats, settings.
- Web dashboard: interactive graph, search/recall, activity feed, review
  queue, traces, working memory, setup wizard, settings (AI providers,
  workspaces, PATs, OAuth consent).
- Auth & workspaces: OAuth 2.1 (authorization code + PKCE, refresh rotation +
  replay detection, revoke), signed PATs with TTL + scopes, per-workspace
  isolation with `ws:<slug>:read/write` scopes, audit logging, rate limiting.
- Deployments: multi-stage non-root Docker image, `docker compose` with
  healthcheck, `.env.example`, offline deterministic mode (no network), and
  OpenAI-compatible LLM/embedding providers (DeepSeek, OpenAI, Ollama,
  OpenRouter, LM Studio, vLLM, local gateways).
- Ops: `tools/amem-setup.mjs` wizard (detect/plan/apply/verify), Codex Stop
  hook ingestion, `tools/amem-loop.mjs`, `tools/eval-recall.mjs` closed-loop
  recall evaluation, smoke tests.
- Benchmarks: OmniMemEval/LoCoMo run (`docs/BENCHMARK.md`) and a real-store
  recall eval showing hit@1 22.5% → hit@3 31.25% → hit@5 35% at ~98% token
  savings vs full-context on a live store.

### Security

- Tokens are signed (HMAC, `kid`-style) and hashed at rest; session cookies
  support `Secure`; auth endpoints rate-limited per IP; MCP-over-HTTP
  requires OAuth/PAT by default (`AMEM_MCP_OAUTH=1`).
