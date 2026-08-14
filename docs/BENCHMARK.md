# Benchmark — Amem on OmniMemEval / LoCoMo

This document records how Amem was evaluated with the
[OmniMemEval](https://github.com/MemTensor/OmniMemEval) harness and what the
scores mean. The goal is a reproducible, honest measurement of how well Amem
serves real agent workflows: can it recall the right knowledge, at low token
cost, with few hallucinations?

> Status: **completed** — full run via
> `scripts/run_locomo_eval.sh --lib amem --version amem_v4`, one Amem
> workspace per LoCoMo conversation (no cross-user bleed), plus a real-store
> recall eval on the live knowledge base (see below).

## Why LoCoMo

[LoCoMo](https://github.com/snap-research/locomo) is a 10-conversation
benchmark of long, multi-session human dialogues (~300 turns total) with
~200 questions each. Every question has a ground-truth answer that requires
**associative, long-horizon recall** across many sessions — exactly the
failure mode Amem targets (context management across many agent turns).

Amem wins by **not** feeding raw conversation history back to the model.
Instead it distills every session into atomic knowledge units at ingest time,
then returns a compact, cited context block within a token budget. LoCoMo's
"memory recall under budget" design is therefore a good fit.

## Adaptor

`bench/omnimemeval/amem_client.py` (installed into the OmniMemEval checkout as
`scripts/client_factory/amem_client.py`) maps the harness interface onto the
Amem REST API:

- `add(messages, user_id)` — uses a **dedicated Amem workspace per LoCoMo
  conversation** (`locomo-exp-user-<N>-amem-v4`), joins the session into a
  speaker-labelled transcript and calls `POST /api/v1/ingest` with
  `extract=true`. Amem's LLM distills the transcript into atomic units, embeds
  them (local, offline-capable embedder), dedups against existing knowledge,
  and links related units.
- `search(query, user_id, top_k)` — calls `POST /api/v1/recall` with a token
  budget (`tokenBudget=12000`, `includeBody=true`) and returns Amem's
  assembled cited context block as `text`.
- `delete(user_id)` — no-op; eval runs against a dedicated throwaway store.

Two harness-side patches are applied idempotently by
`bench/omnimemeval/install.sh`:

- `scripts/locomo/locomo_search.py` — the LoCoMo search stage keeps a
  hard-coded dispatch table, so `"amem": shared_conv_search` was added.
  `shared_conv_search` (one recall per question, both speakers share the
  workspace context) matches Amem's single-store recall; the generic
  two-search path would double token cost without adding signal.
- `scripts/utils/nlp_metrics.py` — `extract_label_json` originally required an
  exact `{"label": "CORRECT"|"WRONG"}` shape; it now also accepts JSON with
  extra fields and plain-text verdicts (`CORRECT` / `WRONG`), which is what
  the local judge returns. Without this patch a group silently fails at judge
  parse time and loses its entire score.

Server-side fix that mattered for the bench: creating a workspace with a
duplicate slug now returns `409` instead of silently reusing another user's
store (`packages/server/src/server.ts`).

## Environment

- Amem server: dedicated bench instance, port `8322`, SQLite at
  `/tmp/amem-bench/bench-run.db`, **separate from the production store**.
- LLM: local OpenAI-compatible proxy (`http://127.0.0.1:15721/v1`,
  model `deepseek-v4-flash`) for Amem distillation and for the harness
  ANSWER + EVAL stages.
- Embeddings: Amem default local (offline) embedder — no external embedding
  API, evaluated as configured out of the box.
- Full 6-step pipeline: Ingestion → Search → Answer → LLM-as-Judge → Metric →
  Report, `num_runs=1`, `top_k=20`, `workers=4`, `llm_workers=10`.

## Reproduce

```sh
git clone https://github.com/MemTensor/OmniMemEval /tmp/OmniMemEval
cd /tmp/OmniMemEval
uv venv --python 3.12 /Users/yuf/.venvs/omnimemeval
uv pip install --python /Users/yuf/.venvs/omnimemeval/bin/python -r requirements_user_memory.txt
python data/locomo/prepare_locomo.py   # downloads locomo10.json

# install the Amem adapter + idempotent harness patches (safe to re-run)
bash /Users/yuf/Documents/amem/bench/omnimemeval/install.sh /tmp/OmniMemEval

# .env.amem — point at your Amem server + LLM endpoint
#   (see bench/omnimemeval/env.amem.example)
#   AMEM_BASE_URL=http://127.0.0.1:8322
#   AMEM_TIMEOUT=1500
#   AMEM_API_TOKEN=<wildcard PAT>
#   ANSWER_MODEL / ANSWER_API_KEY / ANSWER_BASE_URL
#   EVAL_MODEL / EVAL_API_KEY / EVAL_BASE_URL

source /Users/yuf/.venvs/omnimemeval/bin/activate
./scripts/run_locomo_eval.sh --lib amem --env .env.amem --version amem_v4 --workers 4
# results → results/locomo/amem-amem_v4/
```

> Note on NLTK: recent NLTK ships a CWD guard (`nltk/inisec.py`) that blocks
> the `regex` import when the venv lives under the working directory. Keep
> the venv **outside** the repo (e.g. `~/.venvs/…`) or run from a neutral
> cwd, or step 4/5 crash on `Blocked import of regex`.

## Results

Latest run: `amem-amem_v4`, full 6-step pipeline, top-k 20, 4 workers, 10 LLM
workers, 1 run. Answer + judge model: **DeepSeek-V4-Flash** (local proxy).
HTML report: [`docs/bench-report-amem-v4.html`](./bench-report-amem-v4.html).

| Metric | Value | Notes |
| ------ | ----- | ----- |
| Acc (LLM-judge) | **54.87%** | 1540/1540 questions judged, 0 failed groups |
| ROUGE-L F1 | **31.13%** | lexical overlap with ground truth |
| ROUGE-1 F1 | 32.89% | token-level lexical overlap |
| F1 | 28.80% | overall token F1 |
| BLEU-4 | 8.74% | n-gram precision |
| METEOR | 31.82% | lexical + semantic overlap |
| avg context_tokens / recall | **2,382** | tokens sent to the answer model incl. recalled units |
| search latency | 46 ms avg (P95 73 ms) | recall speed on local SQLite |
| ingest latency | 32.2 s avg per conversation | LLM distillation of one LoCoMo session |

### Category breakdown

Category names follow the harness's own mapping
(`scripts/locomo/locomo_metric.py`).

| Category | Questions | LLM-Judge Acc | ROUGE-L | Context Tokens |
| -------- | --------: | ------------: | ------: | -------------: |
| 1 · Multi-Hop | 282 | 36.88% | 20.95% | 2,358 |
| 2 · Temporal Reasoning | 321 | 28.04% | 18.11% | 2,390 |
| 3 · Open-Domain | 96 | 53.13% | 17.88% | 2,315 |
| 4 · Single-Hop | 841 | 71.34% | 41.02% | 2,394 |

Single-hop recall is strong (71%); multi-hop and temporal reasoning are the
hard parts — they require combining several units plus reasoning in one hop,
which is expected for a retrieval memory and matches LoCoMo's design.

### Vs. OmniMemEval reproduced backends (same harness)

| Backend | Deployment | LoCoMo Acc | Context Tokens |
| ------- | ---------- | ---------: | -------------: |
| MemOS | cloud | 88.83% | 5,400 |
| Cognee | cloud | 83.48% | 32,532 |
| EverOS | cloud | 82.75% | 8,559 |
| Hindsight | cloud | 81.99% | 24,683 |
| Mem0 | cloud | 77.68% | 17,395 |
| Letta | cloud | 77.12% | 14,188 |
| MemMachine | local/self-hosted | 73.90% | 2,577 |
| mem9 | cloud | 73.64% | 1,597 |
| Supermemory | cloud | 73.53% | 15,238 |
| MemoryLake | cloud | 72.49% | 5,202 |
| Viking | cloud | 69.33% | 5,964 |
| Zep / Graphiti | cloud | 63.83% | 1,862 |
| Memori | cloud | 41.34% | 8,139 |
| Backboard.io | cloud | 22.40% | 1,198 |
| **Amem (this run)** | **local/self-hosted** | **54.87%** | **2,382** |

Honest reading (do not cherry-pick):

- **Not apples-to-apples on models.** Reference rows used gpt-4.1-mini for
  answers and gpt-4o-mini as judge. Amem used DeepSeek-V4-Flash for both, on a
  fully local stack. A stronger answer model raises the absolute number; the
  judge model matters too.
- **Workspace isolation is fixed in v4.** Each LoCoMo conversation has its own
  Amem workspace, so recall cannot bleed across users. The v3 run shared one
  workspace (22.34%); the +32.5 pp jump to 54.87% mostly comes from removing
  that confound, plus the judge-parse fix that stopped whole groups from being
  dropped.
- **LoCoMo favors long-context LLMs.** It was designed for long-context recall
  (full transcript in prompt). A retrieval memory like Amem answers *from
  distilled units* — cheap (2.4k ctx/query vs 13.5k in v3, ~5× fewer than the
  reference median), but loses verbatim detail that this benchmark rewards.

Interpretation guidance: the Amem profile is *cheap and correct-in-meaning* —
answers come from durable units, not verbatim history, so judge accuracy
outruns lexical overlap (54.87% vs 31.13% ROUGE-L). Compare against the
same-model no-memory baseline before drawing conclusions about absolute
quality; the token-efficiency column is where Amem is designed to win.

## Real-store recall eval (what matters at work)

`tools/eval-recall.mjs` answers the operational question on **your own data**:
can an agent re-locate a past unit from a natural, differently-worded query,
and how many context tokens does that cost vs. the full store?

Latest run on the live store (387 units, 80 queries, budget 1500 tok, topK 5):

| Metric | Before code-symbol ranking | After | Delta |
| ------ | -------------------------- | ----- | ----- |
| hit@1 | 8.75% | 22.5% | +13.75 pp |
| hit@3 | 20% | 31.25% | +11.25 pp |
| hit@5 | 26.25% | 35.0% | +8.75 pp |
| token savings vs full context | 98.4% | 98.2% | ≈ |

The improvement: auto-extracted code-symbol units (`Module:` / `function:` /
`class:` …) are demoted on natural-language queries, while
procedure/decision/lesson units get a small boost
(`AMEM_CODE_SYMBOL_PENALTY`, `AMEM_KNOWLEDGE_BOOST`). Code-flavoured queries
(file extensions, `function`, `module`, `api` …) keep code symbols competitive.

Re-run anytime:

```sh
AMEM_BASE_URL=http://127.0.0.1:8321 AMEM_API_TOKEN=<pat> \
  node tools/eval-recall.mjs --queries 80 --budget 1500 --topK 5
```

Trend history: `docs/eval-recall-history.jsonl` · report:
`docs/eval-recall-report.html`.
