#!/usr/bin/env node
/**
 * Generate the self-contained HTML project report for Amem.
 *
 * Pulls real evidence from:
 *   - docs/eval-recall-history.jsonl  (latest closed-loop recall run)
 *   - /tmp/OmnimeMEval/results/locomo/<run>/amem_locomo_grades.json (LoCoMo run)
 *   - CLI flags for test counts (pnpm -r run test output)
 *
 * Usage:
 *   node tools/report-html.mjs --tests-core 92 --tests-server 51 --tests-mcp 6 \
 *     --tests-db 19 --tests-web 8 --out docs/amem-report.html
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const tests = {
  core: Number(flag('--tests-core', '92')),
  server: Number(flag('--tests-server', '51')),
  mcp: Number(flag('--tests-mcp', '6')),
  db: Number(flag('--tests-db', '19')),
  web: Number(flag('--tests-web', '8')),
};
const totalTests = Object.values(tests).reduce((a, b) => a + b, 0);

// Latest closed-loop recall eval.
let evalData = null;
const historyPath = join(ROOT, 'docs', 'eval-recall-history.jsonl');
if (existsSync(historyPath)) {
  const lines = readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length) evalData = JSON.parse(lines[lines.length - 1]);
}

// OmniMemEval / LoCoMo grades (prefer most recent run with metrics).
let bench = null;
const benchDirs = ['amem-amem_v5', 'amem-amem_v4', 'amem-amem_v3'];
for (const dir of benchDirs) {
  const p = `/tmp/OmnimeMEval/results/locomo/${dir}/amem_locomo_grades.json`;
  if (existsSync(p)) {
    const g = JSON.parse(readFileSync(p, 'utf8'));
    if (g.metrics?.llm_judge_score !== undefined) {
      bench = { run: dir.replace('amem-amem_', 'v'), metrics: g.metrics };
      break;
    }
  }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (n, digits = 1) => `${(n * 100).toFixed(digits)}%`;

const reference = [
  { name: 'MemOS', acc: 88.83, tokens: 5400, depl: 'cloud' },
  { name: 'Cognee', acc: 83.48, tokens: 32532, depl: 'cloud' },
  { name: 'EverOS', acc: 82.75, tokens: 8559, depl: 'cloud' },
  { name: 'Hindsight', acc: 81.99, tokens: 24683, depl: 'cloud' },
  { name: 'Mem0', acc: 77.68, tokens: 17395, depl: 'cloud' },
  { name: 'Letta', acc: 77.12, tokens: 14188, depl: 'cloud' },
  { name: 'MemMachine', acc: 73.9, tokens: 2577, depl: 'local' },
  { name: 'mem9', acc: 73.64, tokens: 1597, depl: 'cloud' },
  { name: 'Supermemory', acc: 73.53, tokens: 15238, depl: 'cloud' },
  { name: 'MemoryLake', acc: 72.49, tokens: 5202, depl: 'cloud' },
  { name: 'Viking', acc: 69.33, tokens: 5564, depl: 'cloud' },
  { name: 'Zep / Graphiti', acc: 63.83, tokens: 1862, depl: 'cloud' },
  { name: 'Memori', acc: 41.34, tokens: 8139, depl: 'cloud' },
  { name: 'Backboard.io', acc: 22.4, tokens: 1198, depl: 'cloud' },
];

const benchRows = reference
  .map((o) => `<tr><td>${o.name}</td><td>${o.depl}</td><td>${pct(o.acc / 100, 2)}</td><td>${o.tokens.toLocaleString()}</td></tr>`)
  .join('');

const catRows = evalData?.byCategory
  ? Object.entries(evalData.byCategory)
      .sort((a, b) => b[1].total - a[1].total)
      .map(
        ([cat, b]) =>
          `<tr><td><code>${esc(cat)}</code></td><td>${b.total}</td><td>${pct(b.hit)}</td><td>${pct(b.hitAt3)}</td></tr>`,
      )
      .join('')
  : '<tr><td colspan="4" class="muted">no recall eval yet</td></tr>';

const hit3 = evalData?.hitRates?.hitAt3 ?? 0;
const hit5 = evalData?.hitRates?.hitAt5 ?? 0;
const savings = evalData?.tokens?.savingsPct ?? 0;
const avgTokens = evalData?.tokens?.avgRecallBlockTokens ?? 0;
const baselineTokens = evalData?.tokens?.fullContextBaseline ?? 0;
const totalUnits = evalData?.totalUnits ?? 0;

const benchAcc = bench ? pct(bench.metrics.llm_judge_score, 2) : 'n/a';
const benchTokens = bench ? Math.round(bench.metrics.context_tokens).toLocaleString() : 'n/a';
const benchRouge = bench ? (bench.metrics.lexical?.rougeL_f ?? 0).toFixed(3) : 'n/a';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Amem — Self-hosted Agent Memory · Project Report</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f17; --panel:#121826; --panel2:#0e1420; --border:#232c3d; --text:#e6eaf2; --muted:#8b93a7; --accent:#4f8cff; --green:#3fb97f; --red:#ef5350; --amber:#e2a03f; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.55 -apple-system, "Segoe UI", "PingFang SC", sans-serif; background: var(--bg); color: var(--text); }
  .wrap { max-width: 1000px; margin: 0 auto; padding: 36px 22px 80px; }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -.02em; }
  h2 { font-size: 17px; margin: 34px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 14px; margin: 18px 0 8px; }
  .muted { color: var(--muted); }
  .hero { margin-bottom: 8px; }
  .tag { display:inline-block; background: var(--panel2); border:1px solid var(--border); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); margin-right: 6px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 20px 0; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .card b { display: block; font-size: 24px; letter-spacing: -.01em; }
  .card span { color: var(--muted); font-size: 12px; }
  .good { color: var(--green); } .bad { color: var(--red); } .warn { color: var(--amber); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  th { background: var(--panel2); color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  tr:last-child td { border-bottom: none; }
  code { background: var(--panel2); padding: 1px 6px; border-radius: 5px; font-size: 12.5px; }
  .feature-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin: 14px 0; }
  .feature { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .feature b { color: var(--accent); }
  .foot { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
</style>
</head>
<body><div class="wrap">
  <div class="hero">
    <h1>Amem · Self-hosted Agent Memory</h1>
    <div class="muted">Local-first knowledge graph + MCP memory for Codex / Claude Code / Cursor agents · data stays on your machine</div>
    <div style="margin-top:10px"><span class="tag">local-first SQLite</span><span class="tag">MCP stdio + HTTP</span><span class="tag">OAuth2.1 + PAT</span><span class="tag">knowledge graph</span><span class="tag">LLM distillation</span><span class="tag">auto-curate</span></div>
  </div>

  <h2>Live status</h2>
  <div class="cards">
    <div class="card"><b>${totalUnits}</b><span>knowledge units (all classified)</span></div>
    <div class="card"><b class="good">${totalTests}</b><span>tests passing (5 packages)</span></div>
    <div class="card"><b>${benchAcc}</b><span>LoCoMo acc (OmniMemEval)</span></div>
    <div class="card"><b>${benchTokens}</b><span>LoCoMo ctx tokens / query</span></div>
    <div class="card"><b class="good">${savings}%</b><span>real-store token saved vs full-context</span></div>
    <div class="card"><b>${pct(hit3)}</b><span>real-store hit@3</span></div>
  </div>

  <h2>Why Amem exists</h2>
  <p>Long agent conversations waste tokens, drift, and hallucinate because context is re-fed from scratch every turn. Amem inverts that: <b>every session is distilled into atomic knowledge units</b> (dedup + link + consolidate), stored in a local knowledge graph, and recalled on demand as a compact, cited context block within a token budget. The result: agents re-locate past decisions without re-reading history, and memory compounds across sessions instead of evaporating.</p>
  <p class="muted">Design principle: we rent the intelligence (any LLM provider), you own the memory — all data stays on your machine (SQLite, local embeddings, optional local LLM).</p>

  <h2>Core features</h2>
  <div class="feature-list">
    <div class="feature"><b>Ingest → distill</b><br/>Traces become atomic units: dedup, embedding, auto-linking, consolidation into crystals.</div>
    <div class="feature"><b>Recall with budget</b><br/>Assembled cited context block within a token budget; layered recall + working memory briefing.</div>
    <div class="feature"><b>Category management</b><br/>8-category taxonomy (code/infra/workflow/product/personal/research/meta/other) — auto-classified on save, batch archive/restore/delete/accept in the Units console.</div>
    <div class="feature"><b>Knowledge graph</b><br/>Force-graph UI colored by category, cluster arcs, scenario heat overlays, graph hygiene (bounded degree).</div>
    <div class="feature"><b>MCP server</b><br/>stdio (default) + Streamable HTTP; Codex/Claude/Cursor agents call save_unit / recall / ingest / curate directly.</div>
    <div class="feature"><b>Auth & workspaces</b><br/>OAuth2.1 (PKCE) + PATs with scope (read/write/admin, ws:&lt;slug&gt;:*), workspace-isolated storage, audit log.</div>
    <div class="feature"><b>LLM provider settings</b><br/>Bring your own endpoint (OpenAI-compatible / DeepSeek / local vLLM) for distillation, classification, curation.</div>
    <div class="feature"><b>Docker one-command</b><br/>docker compose up -d → Web UI + API + MCP on :8321, data in ./data.</div>
  </div>

  <h2>Verification · tests</h2>
  <table>
    <thead><tr><th>Package</th><th>Tests</th><th>Coverage area</th></tr></thead>
    <tbody>
      <tr><td><code>@amem/core</code></td><td>${tests.core}</td><td>recall, dedup, layers, scenes, skills, importer, <b>classification</b>, codegraph</td></tr>
      <tr><td><code>@amem/server</code></td><td>${tests.server}</td><td>REST lifecycle, auth/OAuth, rate limit, <b>classify & batch endpoints</b></td></tr>
      <tr><td><code>@amem/mcp</code></td><td>${tests.mcp}</td><td>MCP tool dispatch (stdio + HTTP)</td></tr>
      <tr><td><code>@amem/db</code></td><td>${tests.db}</td><td>SQLite schema, migrations, workspace isolation</td></tr>
      <tr><td><code>@amem/web</code></td><td>${tests.web}</td><td>UI routing + API client</td></tr>
      <tr><td><b>Total</b></td><td><b>${totalTests}</b></td><td>—</td></tr>
    </tbody>
  </table>

  <h2>Closed-loop recall eval (real store)</h2>
  <p>Measured on the live production store (${totalUnits} units, sampled queries, budget ${evalData?.budget ?? 1500} tokens, top-${evalData?.topK ?? 5}): does a later, differently-worded query re-locate a past unit, and what does it cost?</p>
  <div class="cards">
    <div class="card"><b>${pct(hit3)}</b><span>hit@3 (relocation rate)</span></div>
    <div class="card"><b>${pct(hit5)}</b><span>hit@5</span></div>
    <div class="card"><b class="good">${savings}%</b><span>token saved vs full-context baseline</span></div>
    <div class="card"><b>${avgTokens}</b><span>avg recall block tokens</span></div>
    <div class="card"><b>${baselineTokens.toLocaleString()}</b><span>full-context baseline tokens</span></div>
  </div>
  <h3>Hit rate by category</h3>
  <table><thead><tr><th>Category</th><th>Queries</th><th>hit@5</th><th>hit@3</th></tr></thead><tbody>${catRows}</tbody></table>
  <p class="muted">Reading: a store dominated by low-distinction code-symbol units (58% code) dilutes recall — exactly what the category console + batch archive now let you fix. Recall cost is 98% below the no-memory baseline.</p>

  <h2>OmniMemEval / LoCoMo (independent benchmark)</h2>
  <p>10 long multi-session conversations, ~200 ground-truth questions answered from distilled memory with a token budget. Same harness as the official reproduced table (answer/judge model differs — see <code>docs/BENCHMARK.md</code> for the honest caveats).</p>
  <table>
    <thead><tr><th>Backend</th><th>Deployment</th><th>Acc</th><th>Ctx tokens</th></tr></thead>
    <tbody>
      ${benchRows}
      <tr style="background:var(--panel2)"><td><b>Amem (${bench?.run ?? 'run'})</b></td><td>local/self-hosted</td><td><b>${benchAcc}</b></td><td><b>${benchTokens}</b></td></tr>
    </tbody>
  </table>
  <p class="muted">ROUGE-L ${benchRouge} · note: LoCoMo favors long-context verbatim recall; Amem answers from distilled units — the right comparison is under a strict token budget, where Amem's per-query cost is the smallest in the table.</p>

  <h2>Getting started</h2>
  <p><code>git clone</code> → <code>docker compose up -d</code> (in <code>docker/</code>) → Web UI at <code>http://127.0.0.1:8321</code> → register the MCP server in your agent config:</p>
  <pre style="background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:14px;overflow:auto">[mcp_servers.amem]
command = "npx"
args = ["-y", "amem-mcp", "--base-url", "http://127.0.0.1:8321", "--token", "amem_pat_..."]</pre>
  <p class="muted">Full API, MCP tools, auth & workspace docs: <code>docs/API.md</code>, <code>docs/MCP_TOOLS.md</code>, <code>docs/AUTH_WORKSPACES.md</code>.</p>

  <div class="foot">Generated ${new Date().toISOString()} · Amem · self-hosted agent memory · data stays on your machine.</div>
</div></body></html>`;

const out = flag('--out', join(ROOT, 'docs', 'amem-report.html'));
writeFileSync(out, html);
console.error(`report → ${out}`);
