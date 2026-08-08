#!/usr/bin/env node
/**
 * E2E smoke test: boots the built @amem/server against a temp sqlite db,
 * then exercises health / ingest / recall / search / stats over HTTP.
 * Requires the server to be built (packages/server/dist) and db/core built.
 * Usage: node tools/smoke.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../packages/server/dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'amem-smoke-'));
const config = {
  dbPath: join(dir, 'smoke.db'),
  host: '127.0.0.1',
  port: 0, // ephemeral
  embedding: { mode: 'offline', dims: 64 },
  llm: {},
  thresholds: {
    minSourcesForCrystal: 3,
    dedupSimThreshold: 0.9,
    linkSimThreshold: 0.72,
    contradictionThreshold: 0.6,
    decayPerDay: 0.02,
    forgetThreshold: 0.3,
    workingMemoryBudget: 2000,
    recallBudget: 3000,
  },
  jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 },
};

function assert(cond, msg) {
  if (!cond) {
    console.error('SMOKE FAIL:', msg);
    process.exit(1);
  }
}

const { app, url } = await createServer(config, { listen: true });

async function j(method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  assert(res.status < 400, `${method} ${path} -> ${res.status}`);
  return data;
}

console.log('booted at', url);
const h = await j('GET', '/api/v1/health');
assert(h.ok === true, 'health.ok');
console.log('health ok', h.embeddingMode);

const ingestBody = {
  title: 'Architecture review: mem218',
  content:
    'We decided to use a local-first knowledge graph for agent memory. ' +
    'The plan is to distill traces into atomic units and link them automatically. ' +
    'Procedures: index new material on ingest. Preferences: data stays on our disk.',
  contentType: 'text/plain',
};
const ig = await j('POST', '/api/v1/ingest', ingestBody);
assert(Array.isArray(ig.units) && ig.units.length >= 1, 'ingest produced units');
console.log('ingest ok, units:', ig.units.length, 'saved tokens:', ig.tokensSavedByDedup);

const rc = await j('POST', '/api/v1/recall', {
  query: 'how should agent memory be stored',
  tokenBudget: 2000,
});
assert(rc.items.length >= 1 && rc.text.length > 0, 'recall returns context');
console.log(
  'recall ok, items:',
  rc.items.length,
  'tokens:',
  rc.usedTokens,
  'grounded:',
  rc.grounded,
);

const st = await j('GET', '/api/v1/stats');
console.log('stats ok, units:', st.counts.units, 'traces:', st.counts.traces);

const wm = await j('GET', '/api/v1/working-memory');
console.log('working-memory ok, tokens:', wm.tokenCount);

await app.close();
console.log('\nSMOKE PASSED');
