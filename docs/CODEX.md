# Using Amem as Codex memory

Amem is designed to be the **shared, durable memory layer** for Codex (and other agents). The Web UI Activity tab shows:

1. **Newly added knowledge** — units created by `ingest` / `save_unit`
2. **Used in context** — units returned by `recall` / `search`


## Preferred: HTTP MCP + OAuth (automatic)

HTTP MCP is **OAuth-first** (MCP OAuth / RFC 9728 + PKCE). Codex discovers metadata, optionally DCR-registers, opens a browser once, then refreshes tokens automatically.

```toml
[mcp_servers.amem]
url = "http://127.0.0.1:8321/mcp"
auth = "oauth"
bearer_token_env_var = "AMEM_API_TOKEN"
startup_timeout_sec = 20

[mcp_servers.amem.env]
AMEM_API_TOKEN = "amem_pat_..."   # fallback if OAuth session not yet established
AMEM_WORKSPACE = "personal"
```

One-time:
```sh
pnpm pat:codex                 # mint PAT fallback + wire config/hooks
# restart Codex Desktop
codex mcp login amem           # browser OAuth (PKCE); thereafter automatic
```

Endpoints Codex uses:
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register` (DCR public client)
- `/oauth/authorize` + `/oauth/token` (auth code + PKCE S256, refresh rotation)

PAT (`amem_pat_*`) remains valid Bearer fallback for hooks/stdio. Access tokens are `amem_atk_*`.

## 1. One database for UI + Codex

Codex MCP and the Amem server **must** point at the same SQLite file.

```sh
export AMEM_DB_PATH=/Users/yuf/Documents/amem/data/amem.db
export AMEM_HOST=127.0.0.1
export AMEM_PORT=8321
```

Start the server (API + Web):

```sh
cd /Users/yuf/Documents/amem
pnpm build
pnpm --filter @amem/server start
# open http://127.0.0.1:8321  → Activity tab
```

## 2. Register MCP in Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.amem]
command = "node"
args = ["/Users/yuf/Documents/amem/packages/mcp/dist/cli.js"]
cwd = "/Users/yuf/Documents/amem"
startup_timeout_sec = 20

[mcp_servers.amem.env]
AMEM_DB_PATH = "/Users/yuf/Documents/amem/data/amem.db"
```

Then **restart Codex Desktop** so the `amem_*` tools appear in a new thread.

## 3. How Codex should use memory every turn

Recommended loop (also encoded in project `AGENTS.md`):

1. **Session start**: `working_memory` + `recall` for the active project/topic
2. **While working**: `save_unit` for durable decisions/plans/procedures
3. **Session end** (or large milestone): `ingest` the transcript with `extract=true`
4. Optionally `curate` periodically to link + promote crystals

Amem is **passive storage** — without MCP calls (or a Stop hook), nothing is written. That is intentional: you control what becomes long-term memory.

## 4. Verify in the UI

1. Ask Codex: “用 amem 记住：我们决定用 SQLite 做本地记忆库”
2. Open http://127.0.0.1:8321 → **Activity**
3. You should see a `save_unit` or `ingest` event under **Newly added knowledge**
4. Ask Codex: “从 amem recall 本地记忆库决策”
5. Activity → **Used in context** shows a `recall` event with the unit titles used

## 5. Docker note

If you run Amem only via Docker, point MCP at the same volume path, **or** prefer the local server above so Web + MCP share `./data/amem.db` without path gymnastics.

## Auto-ingest Stop hook

Codex is wired with a **Stop / SessionEnd** hook so each turn is distilled into Amem without relying on the model to remember:

- Global: `~/.codex/hooks.json` → `~/.codex/hooks/amem-stop.sh` → `amem-hook.mjs`
- Project: `./.codex/hooks.json` → `./hooks/amem-stop.sh`
- Script: `tools/amem-hook.mjs` (POSTs `/api/v1/ingest` with `extract/autoLink/autoReview`)

Dry-run:
```sh
echo '{"last_user_message":"we chose SQLite","last_assistant_message":"Agreed, local SQLite for Amem.","cwd":"/Users/yuf/Documents/amem"}' \
  | AMEM_HOOK_DRY_RUN=1 node tools/amem-hook.mjs
```

Heartbeat: `~/.amem/hook-last-seen.json` after a successful ingest.

Restart Codex Desktop after changing hooks so they load.


### HTTP MCP Accept headers

Streamable HTTP clients must send:

`Accept: application/json, text/event-stream`

Initialize creates `Mcp-Session-Id`; subsequent calls must echo it. Amem also accepts a compat shim that injects Accept when missing.


## PAT (Personal Access Token)

A **PAT** is a long-lived secret string (`amem_pat_…`) that identifies *you* (or an agent) to Amem.

| | |
|--|--|
| **What** | Bearer credential, like a GitHub PAT |
| **Format** | `amem_pat_<random>` |
| **Stored** | Only HMAC hash in DB; plaintext shown once |
| **Scopes** | `read` / `write` / `admin` (+ optional workspace binding) |
| **Use** | `Authorization: Bearer amem_pat_…` and/or MCP env `AMEM_API_TOKEN` |
| **vs OAuth access token** | PAT = long-lived for CLI/Codex; `amem_atk_` = short-lived OAuth access |
| **vs legacy AMEM_API_TOKEN** | Legacy is one shared static secret; PAT is per-user, revocable, workspace-scoped |

### Auto-wire Codex

```sh
pnpm pat:codex
# or
node tools/amem-auto-pat.mjs --workspace personal --name codex-auto
```

This will:
1. login/bootstrap admin
2. mint a PAT
3. write `AMEM_API_TOKEN` + `AMEM_WORKSPACE` into `~/.codex/config.toml` `[mcp_servers.amem.env]`
4. write `~/.codex/hooks/amem.env` for Stop hook
5. save token to `~/.amem/codex-pat.token` (mode 600)

Then **restart Codex Desktop**.

## MCP auth: OAuth primary (HTTP), PAT fallback (stdio)

Codex is configured as:

```toml
[mcp_servers.amem]
url = "http://127.0.0.1:8321/mcp"
auth = "oauth"
bearer_token_env_var = "AMEM_API_TOKEN"

[mcp_servers.amem-stdio]
command = "node"
args = ["/Users/yuf/Documents/amem/packages/mcp/dist/cli.js"]
# ... env includes AMEM_API_TOKEN for offline fallback
```

### First-time OAuth login
```sh
codex mcp login amem
```
This opens Amem `/oauth/authorize` (PKCE). After approve, Codex stores OAuth credentials.

### Discovery endpoints
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource/mcp`
- `POST /oauth/register` (dynamic public clients)

### When HTTP MCP returns 401
`WWW-Authenticate: Bearer ... resource_metadata=".../oauth-protected-resource/mcp"`

### Auto setup
```sh
pnpm pat:codex   # mints PAT + writes HTTP OAuth + stdio fallback config
# then
codex mcp login amem
```

## Important: one writer for SQLite

When Amem runs in **Docker** with `./data` bind-mounted, prefer **HTTP MCP only**.

Do **not** also run `amem-stdio` against the same `data/amem.db` from the host at the same time.

If stdio MCP is enabled with `AMEM_BASE_URL` set, it now defaults to an **HTTP proxy backend** (no local SQLite open). Set `AMEM_HTTP_PROXY=0` only when the server is stopped and you need offline file mode.
Two writers across Docker + host can corrupt SQLite indexes (we saw `database disk image is malformed`).

- Primary: `[mcp_servers.amem]` → `http://127.0.0.1:8321/mcp` with OAuth and/or `http_headers` Bearer PAT
- Fallback stdio: only when the Docker/server process is **stopped**

Recovery: stop server → `sqlite3 data/amem.db '.recover' | sqlite3 data/amem.db.new` → rebuild FTS → replace db.


