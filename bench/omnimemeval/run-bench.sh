#!/usr/bin/env bash
#
# Reproducible OmniMemEval / LoCoMo benchmark for Amem.
#
# Spins up a *dedicated* Amem instance (separate DB + port), installs the
# adaptor into a harness checkout, ingests LoCoMo with per-conversation
# workspace isolation, runs the full 6-step pipeline, and renders the
# comparison report into docs/.
#
# Usage:
#   ./bench/omnimemeval/run-bench.sh /path/to/OmniMemEval [--version amem_v4]
#
# Requirements (see docs/BENCHMARK.md):
#   - An OpenAI-compatible LLM endpoint for Amem distillation + harness
#     ANSWER/EVAL stages (override AMEM_LLM_* / ANSWER_* / EVAL_* below).
#   - Python venv with OmniMemEval requirements (outside the harness dir).
#   - Amem repo built: `pnpm build`.
#
set -euo pipefail

HARNESS="${1:?usage: run-bench.sh /path/to/OmniMemEval [--version v]}"
VERSION="${2:-amem_v4}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── config (override via env) ──────────────────────────────────────────────
BENCH_PORT="${BENCH_PORT:-8322}"
BENCH_DB="${BENCH_DB:-/tmp/amem-bench/bench.db}"
LLM_BASE_URL="${AMEM_LLM_BASE_URL:-http://127.0.0.1:15721/v1}"
LLM_MODEL="${AMEM_LLM_MODEL:-deepseek-v4-flash}"
LLM_API_KEY="${AMEM_LLM_API_KEY:-local}"
WORKERS="${BENCH_WORKERS:-4}"
LLM_WORKERS="${BENCH_LLM_WORKERS:-10}"
VENV_PY="${OMNIMEMEVAL_PYTHON:-$HOME/.venvs/omnimemeval/bin/python}"

echo "── 1/6 start dedicated Amem bench instance (port $BENCH_PORT, db $BENCH_DB)"
(
  cd "$REPO_DIR"
  AMEM_DB_PATH="$BENCH_DB" \
  AMEM_PORT="$BENCH_PORT" \
  AMEM_HOST=127.0.0.1 \
  AMEM_AUTH_ENABLED=true \
  AMEM_LLM_BASE_URL="$LLM_BASE_URL" \
  AMEM_LLM_MODEL="$LLM_MODEL" \
  AMEM_LLM_API_KEY="$LLM_API_KEY" \
    node packages/server/dist/cli.js \
  ) > /tmp/amem-bench/bench-server.log 2>&1 &
BENCH_PID=$!
trap 'kill "$BENCH_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$BENCH_PORT/api/v1/health" >/dev/null; then break; fi
  sleep 1
done

BOOT_PAT="$(grep -o 'PAT (save once): amem_pat_[A-Za-z0-9_-]*' /tmp/amem-bench/bench-server.log | head -1 | awk '{print $4}')"
if [[ -z "$BOOT_PAT" ]]; then
  echo "bootstrap PAT not found — reuse the saved PAT from a previous run:" >&2
  cat /tmp/amem-bench/bench-server.log >&2
  exit 1
fi

WILD_PAT="$(curl -s -X POST "http://127.0.0.1:$BENCH_PORT/api/v1/auth/tokens" \
  -H "Authorization: Bearer $BOOT_PAT" -H 'Content-Type: application/json' \
  -d '{"name":"bench-wildcard","scopes":["read","write","admin"],"workspaceIds":["*"]}' \
  | "$VENV_PY" -c 'import sys,json; print(json.load(sys.stdin)["token"])')"
echo "  wildcard PAT ready (${WILD_PAT:0:16}…)"

echo "── 2/6 install adaptor into harness"
"$SCRIPT_DIR/install.sh" "$HARNESS"

echo "── 3/6 prepare LoCoMo data"
(
  cd "$HARNESS"
  "$VENV_PY" data/locomo/prepare_locomo.py >/dev/null
)

echo "── 4/6 write .env.amem"
cat > "$HARNESS/.env.amem" <<EOF
AMEM_BASE_URL=http://127.0.0.1:$BENCH_PORT
AMEM_API_TOKEN=$WILD_PAT
AMEM_TIMEOUT=1500

ANSWER_MODEL=$LLM_MODEL
ANSWER_BASE_URL=$LLM_BASE_URL
ANSWER_API_KEY=$LLM_API_KEY

EVAL_MODEL=$LLM_MODEL
EVAL_BASE_URL=$LLM_BASE_URL
EVAL_API_KEY=$LLM_API_KEY

OMNIMEMEVAL_MEMORY_MAX_RETRIES=8
LLM_MAX_RETRIES=4
LLM_WORKERS=$LLM_WORKERS
TOPK=20
NUM_RUNS=1
EOF

echo "── 5/6 run full 6-step pipeline (ingestion → search → answer → judge → metric → report)"
(
  cd "$HARNESS"
  source "$(dirname "$VENV_PY")/activate"
  ./scripts/run_locomo_eval.sh --lib amem --env .env.amem \
    --version "$VERSION" --workers "$WORKERS" --llm-workers "$LLM_WORKERS"
)

echo "── 6/6 render comparison report"
"$REPO_DIR/tools/bench-report.mjs" \
  --results "$HARNESS/results/locomo/amem-$VERSION" \
  --out "docs/bench-report-$VERSION.html"

echo "done → docs/bench-report-$VERSION.html"
