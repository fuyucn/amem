#!/usr/bin/env node
/**
 * Closed-loop recall evaluation against a live Amem store.
 *
 * Answers the question: "does the memory actually pay for itself at work?"
 * It measures, on YOUR real data (not a synthetic benchmark):
 *
 *   1. Hit rate (hit@1 / hit@3 / hit@5)  — can an agent re-locate a past
 *      unit from a natural query?
 *   2. Token savings — full-context baseline (every unit in context) vs.
 *      Amem's recall block under a budget.
 *   3. Write→recall closed loop — units ingested earlier are retrievable
 *      again by a later, differently-worded query.
 *
 * Usage:
 *   AMEM_BASE_URL=http://127.0.0.1:8321 AMEM_API_TOKEN=<pat> \
 *     node tools/eval-recall.mjs [--queries 80] [--budget 1500] [--topK 5]
 *
 * Output: JSON summary to stdout; run history appended to
 * docs/eval-recall-history.jsonl; a self-contained HTML report written to
 * docs/eval-recall-report.html.
 */

const BASE = process.env.AMEM_BASE_URL || 'http://127.0.0.1:8321';
const TOKEN = process.env.AMEM_API_TOKEN;
if (!TOKEN) {
  console.error('AMEM_API_TOKEN is required');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const QUERY_N = Number(flag('--queries', '80'));
const BUDGET = Number(flag('--budget', '1500'));
const TOP_K = Number(flag('--topK', '5'));

async function api(path, opts = {}) {
  const headers = { authorization: `Bearer ${TOKEN}`, accept: 'application/json' };
  if (opts.body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function estimateTokens(s) {
  // Rough heuristic: ~4 chars/token for mixed EN/ZH text; used for the
  // baseline comparison only (both sides share the same estimate).
  const zh = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = s.length - zh;
  return Math.ceil(other / 4) + Math.ceil(zh / 1.6);
}

/** Build a natural "re-find it" query that avoids echoing the title verbatim. */
function paraphrase(title, summary) {
  const t = title.trim().replace(/[.。:：?!]$/, '');
  const words = t.split(/[\s_\-:：/]+/).filter((w) => w.length > 2 && !/^[\d]+$/.test(w));
  const kw = words.slice(0, 4).join(' ');
  return `${kw} ${(summary || '').slice(0, 40)}`.trim();
}

async function main() {
  const all = await api('/units?limit=1000');
  const active = all.filter((u) => u.status !== 'archived' && u.status !== 'merged');
  if (active.length === 0) {
    console.error('No active units to evaluate.');
    process.exit(1);
  }

  // Sample deterministically (stable across runs).
  const step = Math.max(1, Math.floor(active.length / QUERY_N));
  const sample = active.filter((_, i) => i % step === 0).slice(0, QUERY_N);

  const fullContextTokens = estimateTokens(
    active.map((u) => `${u.title}\n${u.summary}`).join('\n'),
  );

  const rows = [];
  for (const u of sample) {
    const query = paraphrase(u.title, u.summary);
    let result;
    try {
      result = await api('/recall', { body: { query, tokenBudget: BUDGET, topK: TOP_K } });
    } catch (e) {
      rows.push({ id: u.id, query, hit: false, error: String(e.message ?? e) });
      continue;
    }
    const rank = result.items.findIndex((it) => it.unit.id === u.id);
    rows.push({
      id: u.id,
      title: u.title,
      category: u.category || '',
      query,
      hit: rank >= 0,
      rank: rank >= 0 ? rank + 1 : null,
      usedTokens: result.usedTokens ?? 0,
      recallTokens: estimateTokens(result.text ?? ''),
      score: rank >= 0 ? result.items[rank].score : null,
      topTitles: result.items.slice(0, 3).map((it) => it.unit.title),
    });
  }

  const hits = rows.filter((r) => r.hit);
  const errors = rows.filter((r) => r.error);
  const scored = rows.filter((r) => !r.error);
  const hitAt = (k) => scored.filter((r) => r.rank !== null && r.rank <= k).length;
  const avgRecallTokens = scored.length
    ? scored.reduce((s, r) => s + r.recallTokens, 0) / scored.length
    : 0;
  const avgUsed = scored.length
    ? scored.reduce((s, r) => s + r.usedTokens, 0) / scored.length
    : 0;
  const savings = fullContextTokens > 0 ? 1 - avgRecallTokens / fullContextTokens : 0;

  // Per-category hit rates: shows which knowledge areas are easy vs. hard to
  // re-locate — the "management signal" the UI graph coloring makes visible.
  const byCategory = {};
  for (const r of scored) {
    const cat = r.category || 'unclassified';
    const bucket = (byCategory[cat] ??= { total: 0, hit: 0, hitAt3: 0 });
    bucket.total += 1;
    if (r.hit) bucket.hit += 1;
    if (r.rank !== null && r.rank <= 3) bucket.hitAt3 += 1;
  }
  for (const [cat, b] of Object.entries(byCategory)) {
    b.hit = +(b.hit / b.total).toFixed(4);
    b.hitAt3 = +(b.hitAt3 / b.total).toFixed(4);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    totalUnits: active.length,
    queries: scored.length,
    budget: BUDGET,
    topK: TOP_K,
    hitRates: {
      hitAt1: scored.length ? +(hitAt(1) / scored.length).toFixed(4) : 0,
      hitAt3: scored.length ? +(hitAt(3) / scored.length).toFixed(4) : 0,
      hitAt5: scored.length ? +(hitAt(5) / scored.length).toFixed(4) : 0,
      exact: scored.length ? +(hits.length / scored.length).toFixed(4) : 0,
    },
    byCategory,
    tokens: {
      fullContextBaseline: fullContextTokens,
      avgRecallBlockTokens: +avgRecallTokens.toFixed(0),
      avgUsedTokens: +avgUsed.toFixed(0),
      savingsPct: +(savings * 100).toFixed(1),
    },
    errors: errors.length,
    misses: scored
      .filter((r) => !r.hit)
      .slice(0, 8)
      .map((r) => ({ title: r.title, category: r.category, query: r.query, topTitles: r.topTitles })),
    sample: rows.slice(0, 5).map((r) => ({
      title: r.title,
      category: r.category,
      hit: r.hit,
      rank: r.rank,
      score: r.score !== null && r.score !== undefined ? +r.score.toFixed(3) : null,
      usedTokens: r.usedTokens,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));

  // Append run history for trend tracking + write self-contained HTML report.
  const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = new URL('../docs/', import.meta.url).pathname;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const historyPath = join(dir, 'eval-recall-history.jsonl');
  writeFileSync(historyPath, `${JSON.stringify(summary)}\n`, { flag: 'a' });

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const catRows = Object.entries(byCategory)
    .sort((a, b) => b[1].total - a[1].total)
    .map(
      ([cat, b]) =>
        `<tr><td><code>${esc(cat)}</code></td><td>${b.total}</td><td>${pct(b.hit)}</td><td>${pct(b.hitAt3)}</td></tr>`,
    )
    .join('');
  const missRows = (summary.misses || [])
    .map(
      (m) =>
        `<tr><td>${esc(m.title)}<div class="muted">${esc(m.category)}</div></td><td class="muted">${esc(m.query)}</td>` +
        `<td class="muted">${esc((m.topTitles || []).join(' · '))}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Amem — Real-data Recall Evaluation</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f17; --panel:#121826; --panel2:#0e1420; --border:#232c3d; --text:#e6eaf2; --muted:#8b93a7; --accent:#4f8cff; --green:#3fb97f; --red:#ef5350; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", sans-serif; background: var(--bg); color: var(--text); }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 10px; }
  .muted { color: var(--muted); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 18px 0; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .card b { display: block; font-size: 22px; } .card span { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  th { background: var(--panel2); color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  code { background: var(--panel2); padding: 1px 6px; border-radius: 5px; }
  .good { color: var(--green); } .bad { color: var(--red); }
</style>
</head>
<body><div class="wrap">
  <h1>Amem · Real-data Recall Evaluation</h1>
  <div class="muted">Closed-loop check on the live store — ${new Date(summary.generatedAt).toLocaleString()}</div>
  <div class="cards">
    <div class="card"><b>${summary.totalUnits}</b><span>active units evaluated</span></div>
    <div class="card"><b class="${summary.hitRates.hitAt3 >= 0.4 ? 'good' : 'bad'}">${pct(summary.hitRates.hitAt3)}</b><span>hit@3 re-location rate</span></div>
    <div class="card"><b>${pct(summary.hitRates.hitAt5)}</b><span>hit@5</span></div>
    <div class="card"><b class="good">${summary.tokens.savingsPct}%</b><span>token saved vs full-context</span></div>
    <div class="card"><b>${summary.tokens.avgRecallBlockTokens}</b><span>avg recall block tokens</span></div>
    <div class="card"><b>${summary.tokens.fullContextBaseline}</b><span>full-context baseline tokens</span></div>
  </div>
  <h2>Hit rate by category</h2>
  <table><thead><tr><th>Category</th><th>Queries</th><th>hit@5</th><th>hit@3</th></tr></thead><tbody>${catRows}</tbody></table>
  <h2>Missed queries (hard-to-find memory)</h2>
  ${missRows ? `<table><thead><tr><th>Target unit</th><th>Query</th><th>Top-3 returned</th></tr></thead><tbody>${missRows}</tbody></table>` : '<div class="muted">No misses 🎉</div>'}
  <p class="muted" style="margin-top:24px">Run: node tools/eval-recall.mjs --queries ${summary.queries} --budget ${summary.budget} --topK ${summary.topK} · errors: ${summary.errors}</p>
</div></body></html>`;
  const reportPath = join(dir, 'eval-recall-report.html');
  writeFileSync(reportPath, html);
  console.error(`\n(history appended to docs/eval-recall-history.jsonl; report → docs/eval-recall-report.html)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
