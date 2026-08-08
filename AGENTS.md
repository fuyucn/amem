# Amem project agent instructions

## Persistent memory (required)

This repo’s long-term memory lives in **Amem** (local SQLite knowledge graph), not in chat history.

When the `amem` MCP server is available, you MUST:

### Start of a working session
1. Call `working_memory` (no args or today’s date).
2. Call `recall` with a short query for the active task/project (e.g. current feature name).
3. Ground your plan on returned units; cite unit titles when relevant.

### While working
- After any durable decision, plan, procedure, or lesson: `save_unit` with the right `type`.
- Prefer atomic units (one idea each). Use tags like project slug / area.
- If the user pastes a long transcript or meeting notes: `ingest` with `extract=true`.

### Before ending a substantial session
- `ingest` a short session summary (what changed, open questions, next steps).
- Optionally `curate` with preset `fast` if many new units were added.

### Do not
- Re-state large known project facts from scratch if `recall` already returned them.
- Store secrets (API keys, tokens, passwords) into Amem.

## UI visibility
Humans watch http://127.0.0.1:8321 → **Activity** for new writes and recalls. Prefer clear unit titles so the feed is readable.

## Closed-loop Amem usage (mandatory on this machine)

User requirement: Amem is only valuable if **this agent uses it while working**.

Every non-trivial turn:
1. `node tools/amem-loop.mjs start "<task keywords>"` (or REST equivalent working_memory+recall)
2. Do the work grounded on recalled units
3. `node tools/amem-loop.mjs save decision|procedure|lesson|preference "<title>" "<body>"` for durable outcomes
4. `node tools/amem-loop.mjs end "<milestone summary>"` and/or rely on Stop hook
5. Confirm Activity/Graph feedback before claiming completion

Shared endpoint: http://127.0.0.1:8321  DB: data/amem.db

