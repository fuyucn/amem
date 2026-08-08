#!/usr/bin/env node
/**
 * Amem Stop/Session hook for Codex / Claude-compatible hooks.json.
 * Reads hook JSON on stdin and POSTs a compact turn transcript to /api/v1/ingest.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.AMEM_BASE_URL || 'http://127.0.0.1:8321').replace(/\/$/, '');
const TOKEN = process.env.AMEM_API_TOKEN || '';
const MIN_CHARS = Number(process.env.AMEM_HOOK_MIN_CHARS || 80);
const DRY = process.env.AMEM_HOOK_DRY_RUN === '1';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}
function pickString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}
function flattenMessages(payload) {
  const chunks = [];
  const push = (role, text) => {
    const t = String(text || '').trim();
    if (t) chunks.push(`${role}: ${t}`);
  };
  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) push(m.role || m.type || 'message', m.content || m.text || m.message || '');
  }
  if (Array.isArray(payload.transcript)) {
    for (const m of payload.transcript) push(m.role || 'message', m.content || m.text || '');
  }
  const lastUser = pickString(payload.last_user_message, payload.user_message, payload.input, payload.prompt);
  const lastAssistant = pickString(payload.last_assistant_message, payload.assistant_message, payload.output, payload.response, payload.completion);
  if (lastUser) push('user', lastUser);
  if (lastAssistant) push('assistant', lastAssistant);
  const tpath = pickString(payload.transcript_path, payload.transcriptPath);
  if (!chunks.length && tpath && existsSync(tpath)) {
    try {
      const raw = readFileSync(tpath, 'utf8');
      push('transcript', raw.length > 12000 ? raw.slice(-12000) : raw);
    } catch { /* ignore */ }
  }
  return chunks.join('\n\n');
}
function projectLabel(payload) {
  const cwd = pickString(payload.cwd, payload.workspace_root, payload.workspaceRoot, process.env.PWD);
  if (!cwd) return 'codex-session';
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'codex-session';
}

const raw = readStdin();
if (!raw.trim()) {
  process.stderr.write('[amem-hook] empty stdin — skip\n');
  process.exit(0);
}
let payload = {};
try { payload = JSON.parse(raw); }
catch { payload = { last_assistant_message: raw }; }

const event = pickString(payload.hook_event_name, payload.event, payload.type).toLowerCase();
if (event && /pretool|permission|notification/.test(event) && !/stop|sessionend|end/.test(event)) process.exit(0);

const content = flattenMessages(payload);
if (content.replace(/\s+/g, ' ').length < MIN_CHARS) {
  process.stderr.write(`[amem-hook] content too short (${content.length} chars) — skip\n`);
  process.exit(0);
}

const project = projectLabel(payload);
const sessionId = pickString(payload.session_id, payload.sessionId, payload.thread_id, payload.conversation_id) || `hook-${project}`;
const fp = createHash('sha1').update(content).digest('hex').slice(0, 12);
const title = `Codex turn · ${project} · ${new Date().toISOString().slice(0, 16)} [${fp}]`;
const structured = `Fact: Codex session turn in project ${project}.\n\n${content}`;
const body = {
  title,
  content: structured,
  contentType: 'text/plain',
  sessionId,
  extract: true,
  autoLink: true,
  autoReview: true,
  sourceUri: `codex-hook://${sessionId}/${fp}`,
};

if (DRY) {
  process.stdout.write(JSON.stringify({ ok: true, dryRun: true, body }, null, 2) + '\n');
  process.exit(0);
}

try {
  const res = await fetch(`${BASE}/api/v1/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    process.stderr.write(`[amem-hook] ingest ${res.status}: ${(await res.text()).slice(0, 300)}\n`);
    process.exit(0);
  }
  const json = await res.json();
  const n = Array.isArray(json.units) ? json.units.length : 0;
  process.stderr.write(`[amem-hook] ingested ${n} unit(s) session=${sessionId}\n`);
  try {
    const dir = join(homedir(), '.amem');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hook-last-seen.json'), JSON.stringify({ at: new Date().toISOString(), sessionId, units: n, base: BASE }, null, 2));
  } catch { /* ignore */ }
} catch (err) {
  process.stderr.write(`[amem-hook] ${err instanceof Error ? err.message : String(err)}\n`);
}
process.exit(0);
