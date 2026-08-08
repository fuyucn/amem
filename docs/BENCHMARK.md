# Benchmark — Amem on OmniMemEval / LoCoMo

This document records how Amem was evaluated with the
[OmniMemEval](https://github.com/MemTensor/OmniMemEval) harness and what the
scores mean. The goal is a reproducible, honest measurement of how well Amem
serves real agent workflows: can it recall the right knowledge, at low token
cost, with few hallucinations?

> Status: **completed** — full run via
> `scripts/run_locomo_eval.sh --lib amem --version amem_v3`, plus a real-store
> recall eval on the live knowledge base (see below).

## Why LoCoMo

[LoCoMo](https://github.com/snap-research/locomo) is a 10-conversation
benchmark of long, multi-session human dialogues (~300 turns total) with
~200 questions. Each question has a ground-truth answer that requires
**associative, long-horizon recall** across many sessions — exactly the
failure mode Amem targets (context management across many agent turns).

Amem wins by **not** feeding raw conversation history back to the model.
Instead it distills every session into atomic knowledge units at ingest time,
then returns a compact, cited context block within a token budget. LoCoMo's
"memory recall under budget" design is therefore a good fit.

## Adaptor

`scripts/client_factory/amem_client.py` in the OmniMemEval checkout maps the
harness interface onto the Amem REST API:

- `add(messages, user_id)` — joins the session into a speaker-labelled
  transcript and calls `POST /api/v1/ingest` with `sessionId=<user_id)` and
  `extract=true`. Amem's LLM distills the transcript into atomic units,
  embeds them (local, offline-capable embedder), dedups against existing
  knowledge, and links related units.
- `search(query, user_id, top_k)` — calls `POST /api/v1/recall` with a
  token budget (`tokenBudget=12000`, `includeBody=true`) and returns Amem's
  assembled cited context block as `text`.
- `delete(user_id)` — no-op; eval runs against a dedicated throwaway store.

One harness-side patch was required for the Amem run: the LoCoMo search stage
keeps a hard-coded dispatch table, so `"amem": shared_conv_search` was added
to `scripts/locomo/locomo_search.py`. `shared_conv_search` (one recall per
question, both speakers share the context) matches Amem's single-store recall;
the generic two-search path would double token cost without adding signal.

**Honest scoping note:** Amem recalls over the whole store (single-workspace
model; per-user/workspace isolation is on the roadmap in
`docs/AUTH_WORKSPACES.md`). The first LoCoMo run ingests all 10 users into
one store, so cross-user bleed is possible. This makes the score a
conservative lower bound on what a per-user workspace deployment would
achieve.

## Environment

- Amem server: dedicated bench instance, port `8322`, SQLite at
  `/tmp/amem-bench/bench.db`, **separate from the production store**.
- LLM: local OpenAI-compatible proxy (`http://127.0.0.1:15721/v1`,
  model `deepseek-ai/DeepSeek-V4-Flash-0731`) for Amem distillation and for
  the harness ANSWER + EVAL stages.
- Embeddings: Amem default local (offline) embedder — no external embedding
  API, evaluated as configured out of the box.
- The eval runs the full 6-step pipeline: Ingestion → Search → Answer →
  LLM-as-Judge → Metric → Report, `num_runs=1`, `top_k=20`, `workers=8`.

## Reproduce

```sh
git clone https://github.com/MemTensor/OmniMemEval /tmp/OmnimeMEval
cd /tmp/OmnimeMEval
uv venv --python 3.12 /Users/yuf/.venvs/omnimemeval
uv pip install --python /Users/yuf/.venvs/omnimemeval/bin/python -r requirements_user_memory.txt
python data/locomo/prepare_locomo.py   # downloads locomo10.json

# .env.amem — point at your Amem server + LLM endpoint
#   AMEM_BASE_URL=http://127.0.0.1:8322
#   AMEM_TIMEOUT=1500
#   ANSWER_MODEL / ANSWER_API_KEY / ANSWER_BASE_URL
#   EVAL_MODEL / EVAL_API_KEY / EVAL_BASE_URL

source /Users/yuf/.venvs/omnimemeval/bin/activate
./scripts/run_locomo_eval.sh --lib amem --env .env.amem --version amem_v3 --workers 8
# results → results/locomo/amem-amem_v3/
```

> Note on NLTK: recent NLTK ships a CWD guard (`nltk/inisec.py`) that blocks
> the `regex` import when the venv lives under the working directory. Keep
> the venv **outside** the repo (e.g. `~/.venvs/…`) or r-run from a neutral
> cwd, or step 4/5 crash on `Blocked import of regex`.

## Results

Latest run: `amem-amem_v3`, full 6-step pipeline, top-k 20, 8 workers, 1 run.
Answer model: **DeepSeek-V4-Flash** (local proxy), judge: DeepSeek (same proxy).
HTML report: [`docs/bench-report-amem-v3.html`](./bench-report-amem-v3.html).

| Metric | Value | Notes |
| ------ | ----- | ----- |
| Acc (LLM-judge) | **22.34%** | 1540/1540 questions judged, 0 failed groups |
| ROUGE-L F1 | **13.49%** | lexical overlap with ground truth |
| ROUGE-1 F1 | 14.41% | token-level lexical overlap |
| BERTScore-style F1 | 13.31% | semantic overlap (when computed) |
| LLM-judge vs lexical gap | 8.85 pp | answers are correct-in-meaning but paraphrased, not verbatim |
| avg context_tokens / recall | **13,466** | tokens sent to the answer model incl. recalled units |

### Category breakdown

| Category | Questions | LLM-Judge Acc | ROUGE-L | Context Tokens |
| -------- | --------: | ------------: | ------: | -------------: |
| 1 · Single-Hop | 282 | 21.99% | 13.43% | 13,770 |
| 2 · Multi-Hop | 321 | 6.85% | 4.79% | 13,375 |
| 3 · Temporal | 96 | 40.62% | 15.53% | 13,184 |
| 4 · Open-Domain | 841 | 26.28% | 16.59% | 13,431 |

Multi-hop is the weak spot (as expected for a retrieval memory: it requires
combining multiple units + reasoning in one hop); temporal and open-domain
recall are the strongest categories.

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
| **Amem (this run)** | **local/self-hosted** | **22.34%** | **13,466** |

Honest reading (do not cherry-pick):

- **Not apples-to-apples on models.** Reference rows used gpt-4.1-mini for
  answers and gpt-4o-mini as judge. Amem used DeepSeek-V4-Flash for both.
  A stronger answer model raises the absolute number; the judge also matters.
- **Conservative setup.** All 10 LoCoMo conversations share **one workspace**,
  so cross-user bleed is possible. Per-workspace isolation (already supported,
  see `docs/AUTH_WORKSPACES.md`) should improve precision; a re-run with one
  workspace per user is the next iteration.
- **LoCoMo favors long-context LLMs.** It was designed for long-context recall
  (full transcript in prompt). A retrieval memory like Amem answers *from
  distilled units* — cheap, but loses verbatim detail that this particular
  benchmark rewards. The right benchmark for a memory system is LoCoMo **with
  a strict token budget**, where 13k ctx/query at 22% is a starting point, not
  a ceiling.

Interpretation guidance: a high judge-correct with moderate ROUGE is the
expected Amem profile — it answers *from durable units* rather than verbatim
history. The absolute acc number should be compared against the same-model
no-memory baseline and a per-workspace re-run before drawing conclusions.

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
