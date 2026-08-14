#!/usr/bin/env bash
#
# Install the Amem OmniMemEval adaptor into a harness checkout.
#
# Usage:
#   ./bench/omnimemeval/install.sh /path/to/OmniMemEval
#
# What it does:
#   1. Copies scripts/client_factory/amem_client.py into the harness.
#   2. Registers "amem" in scripts/client_factory/registry.py.
#   3. Routes "amem" to shared_conv_search in scripts/locomo/locomo_search.py.
#   4. Patches utils.nlp_metrics.extract_label_json so local LLM judges that
#      return extra JSON keys (e.g. {"label": ..., "explanation": ...}) parse.
#
set -euo pipefail

HARNESS="${1:?usage: install.sh /path/to/OmniMemEval}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLIENT_SRC="$SCRIPT_DIR/amem_client.py"
CLIENT_DST="$HARNESS/scripts/client_factory/amem_client.py"
REGISTRY="$HARNESS/scripts/client_factory/registry.py"
SEARCH="$HARNESS/scripts/locomo/locomo_search.py"

[ -f "$CLIENT_SRC" ] || { echo "missing $CLIENT_SRC" >&2; exit 1; }
[ -f "$REGISTRY" ] || { echo "not a harness checkout: $REGISTRY" >&2; exit 1; }
[ -f "$SEARCH" ] || { echo "not a harness checkout: $SEARCH" >&2; exit 1; }

cp "$CLIENT_SRC" "$CLIENT_DST"
echo "copied $CLIENT_DST"

if ! grep -q '"amem":' "$REGISTRY"; then
  python3 - "$REGISTRY" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
marker = '    "mem9":        ("mem9_client",        "Mem9Client"),'
replacement = marker + '\n    "amem":       ("amem_client",        "AmemClient"),'
if marker not in text:
    raise SystemExit(f"registry marker not found in {path}")
open(path, "w").write(text.replace(marker, replacement, 1))
PY
  echo "registered amem in $REGISTRY"
else
  echo "amem already registered in $REGISTRY"
fi

if ! grep -q '"amem": shared_conv_search' "$SEARCH"; then
  python3 - "$SEARCH" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
marker = '        "mem9": generic_text_search,'
replacement = marker + '\n        "amem": shared_conv_search,'
if marker not in text:
    raise SystemExit(f"search dispatch marker not found in {path}")
open(path, "w").write(text.replace(marker, replacement, 1))
PY
  echo "wired amem search in $SEARCH"
else
  echo "amem search already wired in $SEARCH"
fi

# 4. Tolerate judge responses with extra JSON keys (idempotent).
NLP_METRICS="$HARNESS/scripts/utils/nlp_metrics.py"
if grep -q 'plain JSON object with a "label" key' "$NLP_METRICS"; then
  echo "extract_label_json already patched in $NLP_METRICS"
else
  python3 - "$NLP_METRICS" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
old = '''def extract_label_json(text: str) -> str | None:
    """Extract ``{"label": "VALUE"}`` from LLM grader output."""
    pattern = r'\\{\\s*"label"\\s*:\\s*["\\']([^"\\']*)["\\']\\s*\\}'
    match = re.search(pattern, text)
    if match:
        return match.group(0)
    return None'''
new = '''def extract_label_json(text: str) -> str | None:
    """Extract ``{"label": "VALUE"}`` from LLM grader output.

    Tolerates extra JSON keys (e.g. ``explanation``) and fenced/loose
    output, returning a minimal ``{"label": "VALUE"}`` JSON string.
    """
    # Fast path: response is a plain JSON object with a "label" key.
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and "label" in obj:
            return json.dumps({"label": obj["label"]})
    except (json.JSONDecodeError, TypeError):
        pass
    # Fallback: regex for fenced output like ```json ... ``` or prose
    # followed by a label object with optional extra keys.
    pattern = r'\\{\\s*"label"\\s*:\\s*["\\']([^"\\']*)["\\']\\s*[,}]'
    match = re.search(pattern, text)
    if match:
        return json.dumps({"label": match.group(1)})
    # Last resort: standalone CORRECT/WRONG verdict (no JSON at all).
    word = re.search(r'\\b(CORRECT|WRONG)\\b', text, flags=re.IGNORECASE)
    if word:
        return json.dumps({"label": word.group(1).upper()})
    return None'''
if old not in src:
    raise SystemExit(f"unexpected extract_label_json body in {p}")
open(p, "w").write(src.replace(old, new, 1))
PY
  echo "patched extract_label_json in $NLP_METRICS"
fi

echo "done. Next: source bench/omnimemeval/env.amem.example, then run scripts/run_locomo_eval.sh --lib amem"
