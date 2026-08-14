#!/usr/bin/env node
/**
 * Amem loop helper for Codex/agent sessions.
 * Usage:
 *   node tools/amem-loop.mjs start "keywords..."
 *   node tools/amem-loop.mjs save decision|plan|procedure|lesson|preference|fact "title" "body"
 *   node tools/amem-loop.mjs end "optional milestone summary"
 *   node tools/amem-loop.mjs status
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.AMEM_BASE_URL || 'http://127.0.0.1:8321').replace(/\/$/, '');

// Token resolution: env first, then the auto-generated PAT in ~/.amem, then the
// hook env file. This makes the loop helper work in any shell (subagents, cron,
// new threads) without exporting AMEM_API_TOKEN manually.
function resolveCredential() {
  const home = homedir();
  const tokenFile = join(home, '.amem', 'codex-pat.token');
  const patMetaFile = join(home, '.amem', 'codex-pat.json');
  const hookEnvFile = join(home, '.codex', 'hooks', 'amem.env');
  let token = process.env.AMEM_API_TOKEN || '';
  let workspace = process.env.AMEM_WORKSPACE || '';
  if (!token && existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf8').trim();
  if (!token && existsSync(hookEnvFile)) {
    const m = readFileSync(hookEnvFile, 'utf8').match(/^AMEM_API_TOKEN=(.+)$/m);
    if (m) token = m[1].trim();
  }
  if (!workspace && existsSync(patMetaFile)) {
    try {
      workspace = JSON.parse(readFileSync(patMetaFile, 'utf8')).workspace || '';
    } catch { /* ignore malformed meta */ }
  }
  if (!workspace && existsSync(hookEnvFile)) {
    const m = readFileSync(hookEnvFile, 'utf8').match(/^AMEM_WORKSPACE=(.+)$/m);
    if (m) workspace = m[1].trim();
  }
  return { token, workspace };
}

const { token: TOKEN, workspace: WORKSPACE } = resolveCredential();

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(WORKSPACE ? { 'x-amem-workspace': WORKSPACE } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return data;
}

function printSection(title, body) {
  process.stdout.write(`\n## ${title}\n${body}\n`);
}

async function start(query) {
  const wm = await api('GET', '/working-memory');
  const recall = await api('POST', '/recall', {
    query: query || 'current project decisions procedures open questions',
    tokenBudget: 2500,
    topK: 12,
  });
  printSection('working_memory', wm.text || '(empty)');
  printSection(`recall (${recall.usedTokens}/${recall.budget} tok)`, recall.text || '(empty)');
  printSection('cited units', (recall.items || []).map((it) => `- [${it.score.toFixed(2)}] ${it.unit.title}`).join('\n') || '(none)');
  // local state for this agent turn
  const dir = join(homedir(), '.amem');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last-start.json'), JSON.stringify({ at: new Date().toISOString(), query, recallTitles: (recall.items||[]).map(i=>i.unit.title) }, null, 2));
}

async function save(type, title, body) {
  const unit = await api('POST', '/units', {
    unit: {
      type,
      form: 'unit',
      title,
      summary: body.slice(0, 180),
      body,
      tags: ['codex', 'loop', type],
      status: 'reviewed',
      quality: 0.9,
      confidence: 0.9,
      importance: 0.8,
      decay: 1,
    },
  });
  printSection('saved', `${unit.id}\n${unit.title}\n${unit.summary}`);
}

async function end(summary) {
  if (summary && summary.trim()) {
    const ing = await api('POST', '/ingest', {
      title: `Milestone · ${new Date().toISOString().slice(0, 16)}`,
      content: summary,
      sessionId: process.env.AMEM_SESSION_ID || 'codex-loop',
      extract: true,
      autoLink: true,
      autoReview: true,
    });
    printSection('ingest', `units=${(ing.units||[]).length} dedup=${(ing.deduplicated||[]).length}`);
  }
  const act = await api('GET', '/activity?limit=10');
  const graph = await api('GET', '/graph?clusters=1');
  printSection('activity', act.map((e) => `- ${e.kind}: ${e.summary}`).join('\n'));
  printSection('graph', `${graph.nodes.length} nodes / ${graph.links.length} links`);
}

async function status() {
  const h = await api('GET', '/health');
  const s = await api('GET', '/stats');
  const a = await api('GET', '/activity?limit=5');
  printSection('health', JSON.stringify(h));
  printSection('counts', JSON.stringify(s.counts));
  printSection('graph', JSON.stringify(s.graph));
  printSection('recent activity', a.map((e) => `- ${e.kind}: ${e.summary}`).join('\n'));
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!TOKEN) {
    throw new Error(
      'no API token found: set AMEM_API_TOKEN, or run `amem pat create` / ensure ~/.amem/codex-pat.token exists',
    );
  }
  if (cmd === 'start') await start(rest.join(' '));
  else if (cmd === 'save') {
    const [type, title, ...bodyParts] = rest;
    if (!type || !title || !bodyParts.length) throw new Error('usage: save <type> <title> <body...>');
    await save(type, title, bodyParts.join(' '));
  } else if (cmd === 'end') await end(rest.join(' '));
  else if (cmd === 'status' || !cmd) await status();
  else throw new Error(`unknown command ${cmd}`);
} catch (err) {
  process.stderr.write(String(err?.stack || err) + '\n');
  process.exit(1);
}
