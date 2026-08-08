# Deployment & configuration

## One-command Docker (recommended)

```sh
docker compose -f docker/docker-compose.yml up --build -d
```

- Exposes the app on `http://localhost:8321` (web UI + REST API).
- Persists your knowledge in the host directory `../data` (bind mount) at `/data/amem.db` on the container — the same `data/` folder host tools use, so the MCP stdio path and Docker share one SQLite file.
- `HEALTHCHECK` hits `GET /api/v1/health`.

Stop / logs / rebuild:
```sh
docker compose -f docker/docker-compose.yml down
docker compose -f docker/docker-compose.yml logs -f
docker compose -f docker/docker-compose.yml up --build -d
```

## Modes

- **Offline (default)**: deterministic embedder, no LLM configured. Storage, search, recall (semantic-ish via hashing + keyword), and dedup all work with zero network and zero keys.
- **Semantic + distilled**: set `AMEM_EMBEDDING_MODE=api` + `AMEM_EMBEDDING_BASE_URL/MODEL/API_KEY`, and `AMEM_LLM_BASE_URL/MODEL/API_KEY`. Any OpenAI-compatible endpoint works (OpenAI, Ollama, LM Studio, vLLM, Together…).

## Configuration reference

All config is via environment variables (`configFromEnv()` in `@amem/core`). See `.env.example`.

| Var | Default | Purpose |
|-----|---------|---------|
| `AMEM_HOST` / `AMEM_PORT` | `127.0.0.1` / `8321` | Listen address |
| `AMEM_DB_PATH` | `./data/amem.db` | SQLite file location |
| `AMEM_API_TOKEN` | – | Require `Authorization: Bearer <token>` on `/api/*` |
| `AMEM_CORS_ORIGIN` | – | CORS origin (e.g. dev UI); disabled by default |
| `AMEM_WEB_DIR` | `../../apps/web/dist` | Built web UI directory to serve |
| `AMEM_EMBEDDING_MODE` | auto (`offline`) | `offline` or `api` |
| `AMEM_EMBEDDING_BASE_URL/MODEL/API_KEY/DIMS` | – | OpenAI-compatible embeddings |
| `AMEM_LLM_BASE_URL/MODEL/API_KEY` | – | OpenAI-compatible chat (distillation) |
| `AMEM_MIN_SOURCES_FOR_CRYSTAL` | 3 | Sources to promote a unit to a crystal |
| `AMEM_DEDUP_SIM_THRESHOLD` | 0.9 | Cosine threshold to treat as duplicate/merge |
| `AMEM_LINK_SIM_THRESHOLD` | 0.72 | Cosine threshold to propose a link |
| `AMEM_MIN_SHARED_TAGS` | 3 | Shared tags required for an offline tag-overlap link |
| `AMEM_CONTRADICTION_THRESHOLD` | 0.6 | Contradiction detection threshold |
| `AMEM_DECAY_PER_DAY` | 0.02 | Decay applied per day |
| `AMEM_FORGET_THRESHOLD` | 0.3 | Below this, active units are archived |
| `AMEM_WORKING_MEMORY_BUDGET` | 3000 | Tokens in a working-memory briefing |
| `AMEM_RECALL_BUDGET` | 4000 | Default tokens for a recall context block |
| `AMEM_CODE_SYMBOL_PENALTY` | 0.18 | Demotion for auto-extracted code symbols on natural-language queries |
| `AMEM_KNOWLEDGE_BOOST` | 0.06 | Boost for procedure/decision/lesson units on natural-language queries |
| `AMEM_JOBS_ENABLED` | true | Background consolidation scheduler |
| `AMEM_JOBS_INTERVAL_MS` | 30000 | Scheduler tick |
| `AMEM_JOBS_MAX_PER_HOUR` | 60 | Consolidation rate cap |
| `AMEM_JOBS_TOKEN_BUDGET_DAILY` | 200000 | Daily job token cap |
| `AMEM_AUTO_PRECIPITATE` | off | Auto-precipitate assets after every ingest: `off` \| `fast` (heuristic-only, no LLM) \| `auto` \| `full` |
| `AMEM_AUTO_PRECIPITATE_MIN_INTERVAL_MS` | 60000 | Throttle between auto-precipitation passes |
| `AMEM_AUTH_ENABLED` | false | Require real user accounts (login/PAT/OAuth) instead of a single shared token |
| `AMEM_TRUST_PROXY` | false | Trust `X-Forwarded-For` for client IPs (rate limits). Enable only behind a reverse proxy |
| `AMEM_COOKIE_SECURE` | false | Append `Secure` to the OAuth session cookie (HTTPS behind a proxy) |
| `AMEM_AUTH_SECRET` | – | HMAC secret for token hashing; changing it invalidates all tokens/sessions |
| `AMEM_ALLOW_LEGACY_API_TOKEN` | unset | Legacy `AMEM_API_TOKEN` accepted only when auth is disabled; set `false` to force off after migrating |
| `AMEM_BOOTSTRAP_ADMIN_EMAIL/PASSWORD` | `admin@localhost` / `admin` | First admin account auto-created when auth is enabled |
| `AMEM_PAT_DEFAULT_TTL_DAYS` | 90 | Default expiry for minted personal access tokens |
| `AMEM_RATE_LIMIT_ENABLED` | true | Master switch for per-IP auth endpoint throttling |
| `AMEM_RATE_LIMIT_LOGIN_PER_MINUTE` | 10 | Max `POST /api/v1/auth/login` attempts/min/IP |
| `AMEM_RATE_LIMIT_BOOTSTRAP_PER_HOUR` | 3 | Max `POST /api/v1/auth/bootstrap` attempts/hour/IP |
| `AMEM_RATE_LIMIT_OAUTH_PER_MINUTE` | 20 | Max `/oauth/*` (authorize/token/consent/revoke) hits/min/IP |
| `AMEM_RATE_LIMIT_REGISTER_PER_HOUR` | 10 | Max `POST /oauth/register` attempts/hour/IP |
| `AMEM_MCP_OAUTH` | 1 | MCP-over-HTTP: require OAuth/PAT (`1`) or open local demo (`0`) |

See `docs/AUTH_WORKSPACES.md` for the full auth + workspace security model
(OAuth 2.1 PKCE, PAT, scope spec, workspace isolation, audit).

## Launch as a local app

- **Web as an app**: `pnpm --filter @amem/web dev` (dev server on `:5173`) or open the Docker URL; you can wrap the URL in a PWA-style window if you like.
- **Local server**: `pnpm build && pnpm --filter @amem/server start`.
- The **MCP server** is a separate process: `node packages/mcp/dist/cli.js` (stdio) or `pnpm --filter @amem/mcp start` (HTTP transport). Configure it as an MCP server in Codex/Claude Code/Cursor.

## Backup & portability (data sovereignty)

Your data is a single local SQLite file — copy it to back up. For tool-agnostic portability:
- `GET /api/v1/export` → full JSON bundle (restore with `POST /api/v1/import`).
- `GET /api/v1/export/okf` → Open Knowledge Format markdown bundle cloneable into any editor.
