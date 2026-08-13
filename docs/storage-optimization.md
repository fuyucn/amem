# Storage & consolidation optimization

How Amem keeps its continuous-maintenance path (`consolidate`) fast, idempotent,
and cheap as the knowledge base grows. Written after an online research pass on
SQLite/vector-store best practices; every strategy below is implemented and
benchmarked against the real store (`data/amem.db`).

> Status: **implemented** — schema v13, `packages/core/src/consolidate.ts`,
> `packages/core/src/linkgen.ts`, `packages/db/src/storage.ts`.

## Problems found (before)

1. **N+1 reads.** Crystal promotion ran one source-count query per unit.
   With hundreds of units that is hundreds of queries per curate run.
2. **Full-store dirty writes.** `decay` was recomputed from a continuous
   `ageInDays` curve and written back on every run with no tolerance. Any two
   runs minutes apart produced slightly different floats, so every unit was
   rewritten on every pass.
3. **Embedding payload on every read.** Consolidation only touches
   `form/status/decay/importance`, but it loaded `SELECT *` — every unit's
   embedding vector decoded from JSON text. At 3000 units × 768 dims that is
   ~9 MiB parsed per run.
4. **One-link-at-a-time inserts.** Link generation called `createLink` per new
   edge — a transaction per insert.
5. **Link gen loaded all edges twice.** `consolidate` already held `allLinks()`;
   `generateLinks` re-scanned the whole table.
6. **Missing hot-path indexes.** Unit listing by freshness, link degree lookups,
   trace-by-session, version history, and reverse-citation lookups walked full
   tables.
7. **Legacy embedding storage.** Embeddings were JSON text (~4× larger, slow to
   parse, GC-heavy array allocations).

## What changed

### `packages/db/src/storage.ts`
- `allUnits()` — light read that excludes the `embedding` column entirely
  (`LIGHT_UNIT_COLUMNS`). Consolidation and list/graph paths that never touch
  vectors no longer parse megabytes of embedding data.
- `updateUnits(units)` — narrow `UPDATE_UNIT_LIGHT`
  (`form/status/importance/decay` only), one transaction for the whole batch.
  Never touches `embedding`, so a light read can never wipe stored vectors.
- `createLinks(links)` — batch `INSERT` of all generated edges inside one
  transaction (replaces per-link `createLink`).
- `sourceCountsByUnit()` — single aggregate query instead of N+1.
- `allUnitsWithEmbeddings(limit?)` — optional `ORDER BY updated_at DESC LIMIT`
  so link generation only loads a bounded candidate set.
- Embeddings stored as compact **Float32 BLOBs** (legacy JSON text still
  decodes on read). ~4× smaller and no JSON array allocations.

### `packages/core/src/linkgen.ts`
- `generateLinks` accepts `opts.existingLinks` — consolidation passes the edge
  set it already loaded (after pruning), so the table is scanned once per run.
- Returns `{ linksCreated, created: Link[] }` and writes via
  `storage.createLinks(created)`.
- Bounded candidate set: only the freshest `MAX_PAIR_UNITS` (500) active units
  with embeddings are scored, so a large store never loads every vector.

### `packages/core/src/consolidate.ts`
- Reads via `allUnits()` (light) + one `allLinks()` scan.
- Prunes stale shared-tags links, then reuses the surviving set as
  `existingLinks` — **one** edge scan per run.
- Degree centrality computed from surviving + new links in memory (no second
  DB round-trip).
- **Decay quantized to whole days** (`Math.floor(ageInDays(...))`) so the pass
  is idempotent within a day. Rationale: decay is a continuous curve; two runs
  seconds apart differ by ~6e-6, so any epsilon is overwhelmed. Quantizing makes
  the same-day pass a no-op.
- Write-back gated on `Math.abs(diff) > 1e-9` for `decay`/`importance`.
- Grace window (7 days) before auto-archive so fresh knowledge is never pruned.

### `packages/db/src/schema.ts`
- `SCHEMA_VERSION` 12 → 13, migration adds 7 hot-path indexes:
  `idx_units_workspace_status`, `idx_units_workspace_updated`,
  `idx_links_source`, `idx_links_target`, `idx_traces_session`,
  `idx_versions_unit`, `idx_unit_sources_source`.

## Deliberately *not* changed: WAL

Generic SQLite advice says enable `journal_mode = WAL` for write throughput.
Amem keeps `TRUNCATE` on purpose — see the comment in `schema.ts`:

> TRUNCATE (not WAL): the DB file may be shared with host-side tools across a
> bind mount (e.g. Docker Desktop virtiofs). WAL relies on `-shm` shared memory
> which corrupts on that filesystem.

The online "best practice" applies to single-machine local filesystems; the
Docker bind-mount constraint is a hard deployment requirement for Amem, so we
skip WAL and win on the write path via batching + dirty-write detection instead.

## Benchmark (real store: 413 units, 2722 links, 19 MiB)

Run with `node tools/bench-consolidate.mjs` against a temp copy of the live DB
(it never touches production data):

```
- consolidate (skipLinks):           10.1ms  [recordJob×1, allUnits×1, allLinks×1,
                                             sourceCountsByUnit×1, updateUnits×1,
                                             markJob×1, rowsWritten=0]
- consolidate (skipLinks, idempotent re-run):  7.8ms  [rowsWritten=0]
- consolidate (with linkgen):        69.8ms  [createLinks×1, updateUnits×1,
                                             rowsWritten=214, linksCreated=550]
- linkgen embedding payload:         bounded=500 rows (103.3 KiB)
                                    vs full scan 413 rows (103.3 KiB)
- generateLinks (idempotent re-run): 47.6ms  [rowsWritten=0]
- scaling (3000 units × 768d):       full scan 3000 rows (8.8 MiB, ~55ms)
                                    vs bounded 500 rows (1.5 MiB, ~9ms)
```

Highlights:

- **No N+1**: each phase is exactly one query + one batch write.
- **Idempotent**: a second run writes **0 rows**; churn-free maintenance.
- **Payload cut 83%** at 3k units for link generation (1.5 MiB vs 8.8 MiB
  embedding scan).
- Batch writes: 550 links inserted in one transaction; bulk unit updates in one
  transaction.

## Recurring research takeaways applied

- Batch writes inside explicit transactions beat per-row inserts by 10–100× in
  SQLite (fsync per commit is the cost).
- Detect dirty rows before writing — never write back what did not change
  (also keeps `updated_at`/audit semantics clean).
- Don't `SELECT *` when you need three columns; exclude heavy payload columns.
- Hot-path query indexes beat clever application code; add indexes where the
  query plan scans.
- Keep the embedding payload bounded for O(n²)-ish link scoring; freshest-N
  shortlists preserve recall for active work.
- Store vectors binary (Float32 BLOB), not JSON text: smaller, faster to parse,
  no GC churn.
- Context-specific caveats beat generic advice: no WAL under virtiofs bind
  mounts (Docker Desktop).

## Regression tests

- `packages/core/test/core.test.ts` — consolidation is **idempotent and only
  writes units that changed** (second run: 0 rows written).
- `packages/db/test/storage.test.ts` — embedding round-trips (Float32 BLOB,
  legacy JSON still readable); bulk `createLinks`/`updateUnits`.
- `FakeStorage` in `packages/core/test/helpers.ts` implements the extended
  `Storage` interface so core tests exercise the same batch paths.
