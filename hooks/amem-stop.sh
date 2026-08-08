#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Optional env file with PAT (from amem-auto-pat)
if [[ -f "$HOME/.codex/hooks/amem.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "$HOME/.codex/hooks/amem.env"
  set +a
fi
export AMEM_BASE_URL="${AMEM_BASE_URL:-http://127.0.0.1:8321}"
export AMEM_DB_PATH="${AMEM_DB_PATH:-$ROOT/data/amem.db}"
HOOK_JS="$ROOT/tools/amem-hook.mjs"
if [[ ! -f "$HOOK_JS" ]]; then
  HOOK_JS="$HOME/.codex/hooks/amem-hook.mjs"
fi
exec /usr/bin/env node "$HOOK_JS"
