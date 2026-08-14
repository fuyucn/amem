# Data model

Amem stores knowledge as a **graph of units** (nodes) connected by typed **links** (edges), with provenance (sources/citations) and bi-temporal version history. This is AI/LLM-first storage: structured, linkable, evolvable — not a pile of markdown files. (Markdown appears only as an *export* format, e.g. OKF.)

## Three memory forms (episodic → semantic consolidation)

- **Trace** — raw source material / conversation, kept verbatim (high fidelity).
- **Unit** — an atomic piece of knowledge: one idea per unit; searchable, linkable, evolvable.
- **Crystal** — a stable conclusion promoted when backed by `>= minSourcesForCrystal` (default 3) independent sources.

Unit types (8): `fact`, `decision`, `plan`, `procedure`, `preference`, `concept`, `lesson`, `question`.

## Entities

- **Unit** (`id, type, form, title, summary, body, tags[], labels{}, status, quality, confidence, embedding?, created/updated, valid_from/to, source_count, importance, decay, version`)
  - `status`: `pending | reviewed | archived | merged | flagged`
  - `importance`: 0..1 graph importance (degree centrality).
  - `decay`: 0..1 relevance score, lowered over time; below `forgetThreshold` → archived unless recently reinforced.
  - Provenance columns: `workspace_id`, `zone_id`, `created_by_user_id` — every write records *which workspace / partition / user* it belongs to (storage-level isolation).
- **Zone** (`id, workspace_id, slug, name, kind[personal|shared|project|inbox], owner_user_id?, visibility[private|workspace|members], description?, embedding_centroid?, auto, status, created/updated`, `UNIQUE(workspace_id, slug)`) — the partition under a workspace; every unit belongs to exactly one zone.
- **ZoneMember** (`zone_id, user_id, role[owner|editor|reader], created_at`) — ACL for `members`-visibility project zones.
- **Source** (`id, uri?, title, kind[url|file|transcript|manual|note], contentHash, contentLength`)
  - **UnitSource** citation: `(unitId, sourceId, span?)` — the provenance backing a unit.
- **Link** (`id, sourceUnitId, targetUnitId, relation, reason, confidence, auto`)
  - Relations: `supports, contradicts, part_of, extends, precedes, references, related_to, supersedes, caused_by`.
- **Trace** (`id, sessionId?, title, content, contentType, tokenCount`) and **Session** (`id, label, agent?`).
- **Version** — immutable snapshot of a unit at a point in time (`snapshot`, `reason`), powering history + rollback and evolution chains (`supersedes` links).
- **Job** — audit row for every background pipeline run (`kind, status, meta, error, created/finished`).

## Storage

- SQLite tables: `w_meta`, `sessions`, `traces`, `sources`, `units`, `unit_sources`, `links`, `versions`, `tags`, `unit_tags`, `jobs`, `zones`, `zone_members`; plus an FTS5 index over unit text for keyword search.
- Zone scoping is enforced in SQL (`zone_id IN (...json_each...)`) whenever a request context carries `zoneIds`; see `docs/ZONES.md` for the partition/ACL model.
- Embeddings: JSON `{dims, values}` in a nullable column; cosine computed in-process for semantic retrieval.
- Retrieval is **hybrid**: semantic (embedding cosine) + keyword (FTS) + recency + importance + decay, merged and ranked.

## Export / portability

- `export()` → `ExportBundle` (JSON) with everything: graph, units, links, traces, sources, citations.
- `renderOkfBundle(bundle)` → an Open Knowledge Format markdown bundle (`index.md`, `pages/<slug>.md` with YAML frontmatter + Citations, `log.md`) for cross-tool portability.
