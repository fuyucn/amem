#!/usr/bin/env node
/**
 * Generate a self-contained HTML comparison report for an OmniMemEval LoCoMo
 * run against Amem, compared with the official OmniMemEval reproduced scores.
 *
 * Usage:
 *   node tools/bench-report.mjs \
 *     --results /tmp/OmnimeMEval/results/locomo/amem-amem_v3 \
 *     --out docs/bench-report-amem-v3.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const resultsDir = arg('--results', '');
const outPath = arg('--out', 'docs/bench-report.html');
if (!resultsDir) {
  console.error('usage: node tools/bench-report.mjs --results <dir> --out <file.html>');
  process.exit(1);
}

const lib = arg('--lib', 'amem');
const version = arg('--version', resultsDir.split('/').filter(Boolean).pop() || 'amem_vX');
const workers = arg('--workers', '4');
const gradesPath = join(resultsDir, `${lib}_locomo_grades.json`);
const statsPath = join(resultsDir, `${lib}_locomo_ingestion_stats.json`);

function readJson(p, fallback = null) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

const grades = readJson(gradesPath);
if (!grades) {
  console.error(`grades JSON not found: ${gradesPath}`);
  process.exit(1);
}
const stats = readJson(statsPath, {});

const metrics = grades.metrics || {};
const categories = grades.category_scores || {};
const users = grades.user_scores || {};
const lexical = metrics.lexical || {};

const judgeAcc = (metrics.llm_judge_score ?? 0) * 100;
const judgeStd = (metrics.llm_judge_std ?? 0) * 100;
const rougeL = lexical.rougeL_f ?? null;
const rouge1 = lexical.rouge1_f ?? null;
const ctxTokens = Math.round(metrics.context_tokens ?? 0);

// Official OmniMemEval reproduced LoCoMo scores (docs/user_memory/results.md).
// deployment: cloud | local/self-hosted
const reference = [
  { name: 'MemOS', acc: 88.83, tokens: 5400, depl: 'cloud' },
  { name: 'Cognee', acc: 83.48, tokens: 32532, depl: 'cloud' },
  { name: 'EverOS', acc: 82.75, tokens: 8559, depl: 'cloud' },
  { name: 'Hindsight', acc: 81.99, tokens: 24683, depl: 'cloud' },
  { name: 'Mem0', acc: 77.68, tokens: 17395, depl: 'cloud' },
  { name: 'Letta', acc: 77.12, tokens: 14188, depl: 'cloud' },
  { name: 'MemMachine', acc: 73.90, tokens: 2577, depl: 'local/self-hosted' },
  { name: 'mem9', acc: 73.64, tokens: 1597, depl: 'cloud' },
  { name: 'Supermemory', acc: 73.53, tokens: 15238, depl: 'cloud' },
  { name: 'MemoryLake', acc: 72.49, tokens: 5202, depl: 'cloud' },
  { name: 'Viking', acc: 69.33, tokens: 5964, depl: 'cloud' },
  { name: 'Zep / Graphiti', acc: 63.83, tokens: 1862, depl: 'cloud' },
  { name: 'Memori', acc: 41.34, tokens: 8139, depl: 'cloud' },
  { name: 'Backboard.io', acc: 22.40, tokens: 1198, depl: 'cloud' },
];
reference.sort((a, b) => b.acc - a.acc);

const maxAcc = Math.max(100, ...reference.map((r) => r.acc), judgeAcc);

const catNames = {
  1: 'Single-Hop',
  2: 'Multi-Hop',
  3: 'Temporal',
  4: 'Open-Domain',
};

function fmtPct(v, digits = 1) {
  return v === null || v === undefined ? '–' : `${(v * 100).toFixed(digits)}%`;
}

function accBar(acc) {
  const w = Math.max(2, (acc / maxAcc) * 100);
  const hi = acc >= 80;
  const mid = acc >= 60;
  const cls = hi ? 'bar-good' : mid ? 'bar-mid' : 'bar-low';
  return `<div class="bar-row"><span class="bar-label">${acc.toFixed(1)}</span><div class="bar-track"><div class="bar ${cls}" style="width:${w}%"></div></div></div>`;
}

const refRows = reference
  .map((r) => {
    const isAmem = r.name === 'Amem (this run)';
    return `<tr class="${isAmem ? 'row-amem' : ''}">
      <td>${r.name}</td>
      <td><span class="badge ${r.depl === 'local/self-hosted' ? 'badge-local' : 'badge-cloud'}">${r.depl}</span></td>
      <td class="num">${r.acc.toFixed(1)}</td>
      <td class="num">${r.tokens.toLocaleString()}</td>
    </tr>`;
  })
  .join('\n');

const catRows = Object.keys(categories)
  .sort((a, b) => Number(a) - Number(b))
  .map((id) => {
    const c = categories[id];
    const name = catNames[id] || c.category_name || id;
    return `<tr>
      <td>${name}</td>
      <td class="num">${c.total}</td>
      <td class="num">${(c.llm_judge_score * 100).toFixed(1)} ± ${(c.llm_judge_std * 100).toFixed(1)}</td>
      <td class="num">${fmtPct((c.lexical || {}).rougeL_f)}</td>
      <td class="num">${Math.round(c.context_tokens || 0).toLocaleString()}</td>
    </tr>`;
  })
  .join('\n');

const userRows = Object.keys(users)
  .sort()
  .map((uid) => {
    const u = users[uid];
    return `<tr>
      <td>${uid}</td>
      <td class="num">${u.total}</td>
      <td class="num">${(u.llm_judge_score * 100).toFixed(1)}</td>
      <td class="num">${fmtPct((u.lexical || {}).rougeL_f)}</td>
      <td class="num">${Math.round(u.context_tokens || 0).toLocaleString()}</td>
    </tr>`;
  })
  .join('\n');

const ingestTimes = Object.values(stats.user_durations_ms || {});
const ingestSecs =
  ingestTimes.length > 0 ? (ingestTimes.reduce((a, b) => a + b, 0) / 1000).toFixed(0) : '–';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Amem — OmniMemEval LoCoMo Benchmark Report</title>
<style>
  :root {
    --bg: #0f1420; --panel: #171e2e; --panel2: #1d2638; --ink: #e8ecf4;
    --muted: #9aa7bd; --line: #2a3550; --good: #34d399; --mid: #fbbf24; --low: #f87171;
    --accent: #7aa2ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif; }
  header { padding: 32px 40px 20px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, #141b2c, var(--bg)); }
  header h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: .2px; }
  header p { margin: 2px 0; color: var(--muted); }
  main { max-width: 1080px; margin: 0 auto; padding: 28px 40px 80px; }
  section { margin-top: 36px; }
  h2 { font-size: 17px; margin: 0 0 12px; color: var(--accent); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
  .card .value { font-size: 30px; font-weight: 700; margin-top: 6px; }
  .card .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .good { color: var(--good); } .mid { color: var(--mid); } .low { color: var(--low); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  th, td { padding: 9px 14px; text-align: left; border-bottom: 1px solid var(--line); }
  th { background: var(--panel2); color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.row-amem { background: rgba(122, 162, 255, .10); }
  tr.row-amem td:first-child { font-weight: 700; color: var(--accent); }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); }
  .badge-cloud { color: var(--muted); }
  .badge-local { color: var(--good); border-color: rgba(52, 211, 153, .4); }
  .chart { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px 22px; }
  .bar-row { display: grid; grid-template-columns: 96px 1fr 52px; gap: 10px; align-items: center; margin-bottom: 8px; }
  .bar-row .bar-label { color: var(--muted); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { height: 16px; background: var(--panel2); border-radius: 999px; overflow: hidden; }
  .bar { height: 100%; border-radius: 999px; min-width: 2px; }
  .bar-good { background: linear-gradient(90deg, #10b981, var(--good)); }
  .bar-mid { background: linear-gradient(90deg, #d97706, var(--mid)); }
  .bar-low { background: linear-gradient(90deg, #dc2626, var(--low)); }
  .legend { display: flex; gap: 18px; color: var(--muted); font-size: 12px; margin-bottom: 14px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
  .note { background: var(--panel); border-left: 3px solid var(--mid); border-radius: 8px; padding: 12px 16px; color: var(--muted); font-size: 13px; margin-top: 18px; }
  code { background: var(--panel2); padding: 1px 6px; border-radius: 5px; font-size: 12px; }
  footer { color: var(--muted); font-size: 12px; margin-top: 40px; border-top: 1px solid var(--line); padding-top: 16px; }
  @media (max-width: 720px) { main, header { padding-left: 18px; padding-right: 18px; } }
</style>
</head>
<body>
<header>
  <h1>Amem — OmniMemEval LoCoMo Benchmark</h1>
  <p>Memory backend evaluation · LLM-as-Judge accuracy &amp; token efficiency · generated ${new Date().toISOString().slice(0, 10)}</p>
  <p>Run: <code>${version}</code> · full 6-step pipeline · top-k 20 · ${workers} workers · LLM: DeepSeek-V4-Flash (local proxy)</p>
</header>
<main>
  <section>
    <div class="cards">
      <div class="card"><div class="label">LLM-Judge Accuracy</div><div class="value ${judgeAcc >= 80 ? 'good' : judgeAcc >= 60 ? 'mid' : 'low'}">${judgeAcc.toFixed(1)}%<span style="font-size:14px;color:var(--muted)"> ± ${judgeStd.toFixed(1)}</span></div><div class="sub">across ${Object.values(users).reduce((a, u) => a + (u.total || 0), 0)} questions / ${Object.keys(users).length} conversations</div></div>
      <div class="card"><div class="label">ROUGE-L F1</div><div class="value">${fmtPct(rougeL)}</div><div class="sub">lexical overlap with ground truth (ROUGE-1 ${fmtPct(rouge1)})</div></div>
      <div class="card"><div class="label">Context Tokens / Question</div><div class="value ${ctxTokens <= 6000 ? 'good' : ctxTokens <= 16000 ? 'mid' : 'low'}">${ctxTokens.toLocaleString()}</div><div class="sub">avg tokens sent to answer model, incl. Amem recalled context</div></div>
      <div class="card"><div class="label">Ingest Time</div><div class="value">${ingestSecs}s</div><div class="sub">${Object.keys(users).length} LoCoMo conversations distilled</div></div>
    </div>
  </section>

  <section>
    <h2>Overall vs OmniMemEval reproduced backends</h2>
    <div class="chart">
      <div class="legend"><span><i class="bar-good" style="background:var(--good)"></i>LLM-judge accuracy</span><span class="muted">Reference: official OmniMemEval reproduced LoCoMo scores (same harness, gpt-4.1-mini answer / gpt-4o-mini judge)</span></div>
      ${reference.map((r) => `<div class="bar-row"><span class="bar-label">${r.name}${r.name === 'MemMachine' ? ' *' : ''}</span>${accBar(r.acc).replace('<div class="bar-row">', '').replace('</div>', '')}<span class="bar-label" style="color:var(--muted)">${r.tokens.toLocaleString()} tok</span></div>`).join('\n')}
      <div class="bar-row"><span class="bar-label" style="color:var(--accent);font-weight:700">Amem (this run)</span>${accBar(judgeAcc).replace('<div class="bar-row">', '').replace('</div>', '')}<span class="bar-label" style="color:var(--accent);font-weight:700">${ctxTokens.toLocaleString()} tok</span></div>
    </div>
    <div class="note">* MemMachine is the only self-hosted reference row. Amem runs fully local (SQLite + offline embedder + local LLM proxy). This run gives each LoCoMo conversation its own Amem workspace (locomo-exp-user-N-amem-v4), so recall cannot bleed across users; token counts stay low because Amem distills each session into atomic units and returns a compact cited context block instead of raw history.</div>
  </section>

  <section>
    <h2>Category breakdown</h2>
    <table>
      <thead><tr><th>Category</th><th class="num">Questions</th><th class="num">LLM-Judge Acc</th><th class="num">ROUGE-L</th><th class="num">Context Tokens</th></tr></thead>
      <tbody>${catRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Per-conversation scores</h2>
    <table>
      <thead><tr><th>Conversation</th><th class="num">Questions</th><th class="num">LLM-Judge Acc</th><th class="num">ROUGE-L</th><th class="num">Context Tokens</th></tr></thead>
      <tbody>${userRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Reference table (OmniMemEval reproduced)</h2>
    <table>
      <thead><tr><th>Backend</th><th>Deployment</th><th class="num">LoCoMo Acc</th><th class="num">Context Tokens</th></tr></thead>
      <tbody>${refRows}
      <tr class="row-amem"><td>Amem (this run)</td><td><span class="badge badge-local">local/self-hosted</span></td><td class="num">${judgeAcc.toFixed(1)}</td><td class="num">${ctxTokens.toLocaleString()}</td></tr>
      </tbody>
    </table>
  </section>

  <footer>Amem · self-hosted agent memory knowledge graph · data stays on your machine · <a href="https://github.com/" style="color:var(--accent)">oss release</a> · full details in docs/BENCHMARK.md</footer>
</main>
</body>
</html>`;

writeFileSync(outPath, html);
console.log(`report written to ${outPath} (${html.length} bytes)`);
console.log(`  judge acc ${judgeAcc.toFixed(2)}% ± ${judgeStd.toFixed(2)}, ROUGE-L ${fmtPct(rougeL)}, ctx tokens ${ctxTokens}`);
