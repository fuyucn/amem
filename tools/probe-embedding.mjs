#!/usr/bin/env node
/**
 * Offline recall probe: compare embedding-text variants head-to-head on the
 * real SQLite store without touching the running server.
 *
 * Usage:
 *   node tools/probe-embedding.mjs [--limit 80] [--topK 5]
 *
 * Variants:
 *   v0  title+summary+body            (current ingest embedding text)
 *   v1  title+summary+bodyHead(400)   (compact head, less dilution)
 *   v2  weighted title*3+summary*2+bodyHead(400)*1
 *   v3  v1 embeddings + title-token boost in scoring
 */
import Database from '../packages/db/node_modules/better-sqlite3/lib/index.js';
import {
  DEFAULT_EMBEDDING_DIMS,
  hashEmbed,
  cosine,
  normalize,
} from '../packages/core/dist/lib/vector.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const QUERY_N = Number(flag('--limit', '80'));
const DIMS = DEFAULT_EMBEDDING_DIMS;
const BODY_HEAD = 400;
const V2_WEIGHTS = (process.env.V2_WEIGHTS || '3,2,1').split(',').map(Number);
const BASE = process.env.AMEM_BASE_URL || 'http://127.0.0.1:8321';
const TOKEN = process.env.AMEM_API_TOKEN;

if (!TOKEN) {
  console.error('AMEM_API_TOKEN is required (same sample as tools/eval-recall.mjs)');
  process.exit(1);
}

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

const db = new Database('data/amem.db', { readonly: true });

const units = db
  .prepare(
    `SELECT id, title, summary, body, tags, type, status,
            updated_at, decay, importance, zone_id
       FROM units WHERE status NOT IN ('archived','merged')`,
  )
  .all();
db.close();

const parseTags = (raw) => (raw ? raw.split(',').filter(Boolean) : []);

/** Same paraphrase used by tools/eval-recall.mjs. */
function paraphrase(title, summary) {
  const t = title.trim().replace(/[.。:：?!]$/, '');
  const words = t.split(/[\s_\-:：/]+/).filter((w) => w.length > 2 && !/^[\d]+$/.test(w));
  const kw = words.slice(0, 4).join(' ');
  return `${kw} ${(summary || '').slice(0, 40)}`.trim();
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'has']);
function queryTerms(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function keywordOverlap(query, unit) {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const haystack = [unit.title, unit.summary, ...parseTags(unit.tags), unit.body.slice(0, 400)]
    .join(' ')
    .toLowerCase();
  let hits = 0;
  for (const t of terms) if (haystack.includes(t)) hits++;
  return hits / terms.length;
}

function recencyScore(iso) {
  const days = (Date.now() - new Date(iso).getTime()) / 86400000;
  return Math.max(0, 1 - days / 90);
}

function embedUnit(variant, unit) {
  const { title, summary = '', body = '' } = unit;
  const head = body.slice(0, BODY_HEAD);
  if (variant === 'v0') return hashEmbed([title, summary, body].filter(Boolean).join(' '), DIMS);
  if (variant === 'v1') return hashEmbed([title, summary, head].filter(Boolean).join(' '), DIMS);
  if (variant === 'v2') {
    const w = V2_WEIGHTS;
    const [wt, ws, wb] = w;
    const t = hashEmbed(title, DIMS);
    const s = summary ? hashEmbed(summary, DIMS) : new Array(DIMS).fill(0);
    const h = head ? hashEmbed(head, DIMS) : new Array(DIMS).fill(0);
    return normalize(t.map((x, i) => x * wt + s[i] * ws + h[i] * wb));
  }
  throw new Error(`unknown variant ${variant}`);
}

function embedQuery(variant, query) {
  if (variant === 'v2') {
    return hashEmbed(query, DIMS);
  }
  return hashEmbed(query, DIMS);
}

async function run(variant) {
  const rows = [];
  const allApi = await api('/units?limit=1000');
  const activeApi = allApi.filter((u) => u.status !== 'archived' && u.status !== 'merged');
  const step = Math.max(1, Math.floor(activeApi.length / QUERY_N));
  const sample = activeApi.filter((_, i) => i % step === 0).slice(0, QUERY_N);
  const qVecs = new Map(sample.map((u) => [u.id, embedQuery(variant, paraphrase(u.title, u.summary))]));

  for (const target of sample) {
    const query = paraphrase(target.title, target.summary);
    const qv = qVecs.get(target.id);
    const scored = [];
    for (const u of units) {
      const ev = embedUnit(variant, u);
      const sim = cosine(qv, ev);
      const kw = keywordOverlap(query, u);
      let score = Math.max(0, sim) * 0.5 + kw * 0.3;
      score += recencyScore(u.updated_at) * 0.1;
      score += (u.decay || 0) * 0.05;
      score += (u.importance || 0) * 0.05;
      scored.push({ id: u.id, score, sim, kw });
    }
    scored.sort((a, b) => b.score - a.score);
    const rank = scored.findIndex((s) => s.id === target.id);
    rows.push({
      rank: rank >= 0 ? rank + 1 : null,
      target: target.title,
      top: scored.slice(0, 3).map((s) => s.id),
    });
  }

  const hitAt = (k) => rows.filter((r) => r.rank !== null && r.rank <= k).length;
  const n = rows.length;
  return {
    n,
    hitAt1: hitAt(1) / n,
    hitAt3: hitAt(3) / n,
    hitAt5: hitAt(5) / n,
    misses: rows.filter((r) => r.rank === null || r.rank > 5).slice(0, 8).map((r) => `${r.rank ?? 'miss'} ${r.target.slice(0, 50)}`),
  };
}

for (const v of ['v0', 'v1', 'v2']) {
  const r = await run(v);
  console.log(
    `\n[${v}]  hit@1=${(r.hitAt1 * 100).toFixed(1)}%  hit@3=${(r.hitAt3 * 100).toFixed(1)}%  hit@5=${(r.hitAt5 * 100).toFixed(1)}%  (n=${r.n})`,
  );
  console.log('  misses:', r.misses.join(' | ') || 'none');
}
