#!/usr/bin/env node
/**
 * Amem setup wizard (detect → plan → apply → verify)
 *
 *   node tools/amem-setup.mjs detect
 *   node tools/amem-setup.mjs plan
 *   node tools/amem-setup.mjs apply
 *   node tools/amem-setup.mjs verify
 *   node tools/amem-setup.mjs all
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BASE = (process.env.AMEM_BASE_URL || 'http://127.0.0.1:8321').replace(/\/$/, '');
const ROOT = new URL('..', import.meta.url).pathname;
const cmd = process.argv[2] || 'all';

async function http(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

function detect() {
  const docker = spawnSync('docker', ['ps', '--filter', 'name=amem', '--format', '{{.Status}}'], { encoding: 'utf8' });
  const codexCfg = join(homedir(), '.codex', 'config.toml');
  const tokenFile = join(homedir(), '.amem', 'codex-pat.token');
  const hooks = join(homedir(), '.codex', 'hooks.json');
  return {
    baseUrl: BASE,
    repo: ROOT,
    dockerRunning: Boolean(docker.stdout && docker.stdout.includes('Up')),
    dockerStatus: (docker.stdout || '').trim() || null,
    healthUrl: `${BASE}/api/v1/health`,
    codexConfigExists: existsSync(codexCfg),
    codexConfigPath: codexCfg,
    tokenFileExists: existsSync(tokenFile),
    tokenFilePath: tokenFile,
    hooksExists: existsSync(hooks),
    composeFile: join(ROOT, 'docker/docker-compose.yml'),
    autoPatScript: join(ROOT, 'tools/amem-auto-pat.mjs'),
  };
}

function plan(d) {
  const steps = [];
  if (!d.dockerRunning) steps.push({ id: 'docker_up', title: 'Start Amem Docker', run: `docker compose -f ${d.composeFile} up -d` });
  steps.push({ id: 'wait_health', title: 'Wait for /api/v1/health' });
  steps.push({ id: 'pat', title: 'Mint Codex PAT + wire config', run: `node ${d.autoPatScript}` });
  steps.push({ id: 'hooks', title: 'Ensure Stop hook env present' });
  steps.push({ id: 'verify', title: 'Verify health + db-health + MCP challenge' });
  steps.push({ id: 'note', title: 'Restart Codex Desktop after config change' });
  return steps;
}

async function apply(d) {
  const steps = plan(d);
  const log = [];
  for (const s of steps) {
    if (s.id === 'docker_up') {
      const r = spawnSync('docker', ['compose', '-f', d.composeFile, 'up', '-d'], { encoding: 'utf8' });
      log.push({ step: s.id, code: r.status, out: (r.stdout || r.stderr || '').slice(0, 400) });
      // wait
      for (let i = 0; i < 30; i++) {
        const h = await http('/api/v1/health');
        if (h.ok) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    } else if (s.id === 'wait_health') {
      let ok = false;
      for (let i = 0; i < 40; i++) {
        const h = await http('/api/v1/health');
        if (h.ok) { ok = true; log.push({ step: s.id, ok, data: h.data }); break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!ok) log.push({ step: s.id, ok: false });
    } else if (s.id === 'pat') {
      const r = spawnSync(process.execPath, [d.autoPatScript], { encoding: 'utf8', cwd: ROOT });
      log.push({ step: s.id, code: r.status, out: (r.stdout || r.stderr || '').slice(0, 800) });
    } else if (s.id === 'hooks') {
      const envPath = join(homedir(), '.codex', 'hooks', 'amem.env');
      mkdirSync(join(homedir(), '.codex', 'hooks'), { recursive: true });
      const tok = existsSync(d.tokenFilePath) ? readFileSync(d.tokenFilePath, 'utf8').trim() : '';
      if (tok) {
        writeFileSync(envPath, `AMEM_BASE_URL=${BASE}\nAMEM_API_TOKEN=${tok}\nAMEM_WORKSPACE=personal\n`, { mode: 0o600 });
        try { chmodSync(envPath, 0o600); } catch { /* ignore */ }
        log.push({ step: s.id, ok: true, envPath });
      } else {
        log.push({ step: s.id, ok: false, error: 'no token file' });
      }
    } else if (s.id === 'verify') {
      log.push({ step: s.id, ...(await verify()) });
    } else if (s.id === 'note') {
      log.push({ step: s.id, message: 'Restart Codex Desktop, optional: codex mcp login amem' });
    }
  }
  return log;
}

async function verify() {
  const health = await http('/api/v1/health');
  let token = '';
  const tf = join(homedir(), '.amem', 'codex-pat.token');
  if (existsSync(tf)) token = readFileSync(tf, 'utf8').trim();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const db = await http('/api/v1/admin/db-health', { headers });
  const unauth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'setup', version: '0' } } }),
  });
  let mcpPat = null;
  if (token) {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'setup', version: '0' } } }),
    });
    mcpPat = { status: r.status, session: r.headers.get('mcp-session-id') };
  }
  return {
    health: health.data,
    dbHealth: db.data,
    mcpUnauthStatus: unauth.status,
    mcpUnauthWwwAuth: unauth.headers.get('www-authenticate'),
    mcpPat,
    ok: Boolean(health.ok && db.ok && db.data?.ok && unauth.status === 401 && mcpPat?.status === 200),
  };
}

const d = detect();
if (cmd === 'detect') {
  console.log(JSON.stringify(d, null, 2));
} else if (cmd === 'plan') {
  console.log(JSON.stringify(plan(d), null, 2));
} else if (cmd === 'apply') {
  console.log(JSON.stringify(await apply(d), null, 2));
} else if (cmd === 'verify') {
  console.log(JSON.stringify(await verify(), null, 2));
} else if (cmd === 'all') {
  console.log(JSON.stringify({ detect: d, plan: plan(d), apply: await apply(d) }, null, 2));
} else {
  console.error('usage: detect|plan|apply|verify|all');
  process.exit(2);
}
