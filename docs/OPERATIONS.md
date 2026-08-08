# Operations — run Amem in production

How to back up, restore, upgrade, monitor, and troubleshoot a running Amem
instance. Deployment basics live in [`DEPLOYMENT.md`](DEPLOYMENT.md); the
security model lives in [`AUTH_WORKSPACES.md`](AUTH_WORKSPACES.md) and
[`../SECURITY.md`](../SECURITY.md).

## Data layout

Everything lives in one SQLite file (`AMEM_DB_PATH`, default `./data/amem.db`):
units, links, traces, sources, versions, tags, sessions, jobs, settings, and
embeddings. With the Docker compose file, the host directory `../data` is
bind-mounted to `/data` and shared with host-side MCP tools.

> SQLite runs in **WAL mode** with `busy_timeout`, so one writer (the server)
> and several readers (MCP stdio, CLI tools) can share the file safely. Keep
> **one process writing** per database file; point secondary tools at the
> server's REST API (`AMEM_BASE_URL`) instead of opening the file directly.

## Backup

The store is a single file — backups are trivial:

```sh
# Best: ask SQLite to checkpoint WAL first, then copy the DB file.
sqlite3 data/amem.db "PRAGMA wal_checkpoint(TRUNCATE);"
cp data/amem.db backups/amem-$(date +%F).db
```

Against a running Docker container:

```sh
docker exec amem node -e "fetch('http://127.0.0.1:8321/api/v1/health').then(r=>process.exit(r.ok?0:1))"
docker cp amem:/data/amem.db backups/amem-$(date +%F).db
```

Portable, tool-agnostic exports (recommended for long-term archives):

```sh
curl -H "Authorization: Bearer $AMEM_PAT" http://127.0.0.1:8321/api/v1/export > amem-backup.json
curl -H "Authorization: Bearer $AMEM_PAT" http://127.0.0.1:8321/api/v1/export/okf > amem-backup-okf.md
```

Schedule it: a nightly `cron`/`launchd`/compose-sidecar that copies the DB or
JSON export, keeping N generations (e.g. 14) and one off-box copy (NAS, S3,
or a git repo — remember to encrypt anything that leaves the machine).

## Restore

1. Stop the server: `docker compose -f docker/docker-compose.yml down`.
2. Replace the file: `cp backups/amem-<date>.db data/amem.db`.
3. Start again: `docker compose -f docker/docker-compose.yml up --build -d`
   and verify `GET /api/v1/health` → `{ "ok": true }`.

To restore from a JSON/OKF export (e.g. on a fresh instance):

```sh
curl -X POST -H "Authorization: Bearer $AMEM_PAT" -H "Content-Type: application/json" \
  --data-binary @amem-backup.json http://127.0.0.1:8321/api/v1/import
```

Imports dedup against existing units, so re-importing a backup over a live
store is idempotent in practice (check `deduplicated` in the response).

## Upgrade

Amem keeps schema migrations in `packages/db/src/migrations` and applies them
automatically at startup (a version row in `w_meta` tracks the current schema).
To upgrade:

```sh
git pull            # or: docker compose pull / rebuild
docker compose -f docker/docker-compose.yml up --build -d
```

Recommended order: back up first (see above), pull, restart, then run
`node tools/smoke.mjs` or hit `/api/v1/health` + `/api/v1/stats` and eyeball
the Activity feed. Downgrades are not supported — keep the last pre-upgrade
backup for at least one release cycle.

## Monitoring

- **Health**: `GET /api/v1/health` returns `{ ok, version, embeddingMode }`;
  the compose healthcheck polls it every 15s.
- **Stats**: `GET /api/v1/stats` — counts, graph size, token savings
  (`tokensSavedByDedup`, `recallTokensDelivered`, `tokenWasteAvoided`),
  per-day write volume, communities.
- **Activity**: `GET /api/v1/activity` — live feed of writes, recalls,
  searches, and jobs; watch it in the Web UI **Activity** tab.
- **Jobs**: `GET /api/v1/jobs` — background consolidation runs with audit
  rows; a healthy instance consolidates without piling up `pendingReview`.
- **Recall quality**: run `tools/eval-recall.mjs` periodically to track
  hit@1/3/5 and token savings on your real data
  (see [`BENCHMARK.md`](BENCHMARK.md)).

Suggested alert thresholds for a personal/team instance: `pendingReview`
growing beyond ~100, zero successful job runs for 24h, or health failures
for 3 consecutive probes.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Web UI shows old routes / missing tabs | Stale browser tab | Hard refresh (Cmd/Ctrl+Shift+R); routes are real URL paths (`/search`, …) |
| Port 8321 refused | Server not running | `docker compose -f docker/docker-compose.yml up --build -d`; check `docker ps` health |
| `SQLITE_BUSY` from host tools | Two writers on one file | Keep the server as sole writer; point MCP stdio at `AMEM_BASE_URL` instead of the file |
| `401` on MCP/HTTP | Auth enabled, missing/invalid PAT | Mint a scoped PAT in Settings → PATs; pass `Authorization: Bearer amem_pat_*` |
| `429 RATE_LIMITED` on login | Per-IP throttle (10/min) | Wait a minute; set `AMEM_RATE_LIMIT_ENABLED=false` only on trusted localhost |
| Graph looks empty | Filters/archived units | Default graph shows active units only; check `/stats` counts and `/review` for pending work |
| Recall returns noisy code symbols | Code-symbol ranking | Tune `AMEM_CODE_SYMBOL_PENALTY` / `AMEM_KNOWLEDGE_BOOST` (see `DEPLOYMENT.md`) |
| Search misses known content | Query phrased differently | Use `/search` keywords or `fullText=1`; recall is semantic, search is keyword-first |

## Data retention & privacy

- Amem never phones home: offline mode needs no network, no keys, and no
  accounts. The LLM/embedding providers you configure are the only external
  callers, and only for the content you send them.
- Deleting a unit removes it and its links/versions; `GET /api/v1/export`
  gives you a full copy before any destructive cleanup.
- Workspaces isolate data at the storage layer: `ws:<slug>:read/write`
  scopes cannot cross into another workspace.
