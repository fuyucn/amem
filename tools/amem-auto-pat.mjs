#!/usr/bin/env node
/**
 * Auto-mint a Codex PAT and wire it into ~/.codex/config.toml [mcp_servers.amem.env].
 *
 * Usage:
 *   node tools/amem-auto-pat.mjs
 *   node tools/amem-auto-pat.mjs --workspace personal --name codex
 *   node tools/amem-auto-pat.mjs --email admin@localhost --password admin
 *
 * Env (optional):
 *   AMEM_BASE_URL=http://127.0.0.1:8321
 *   AMEM_DB_PATH=...
 *   AMEM_BOOTSTRAP_ADMIN_EMAIL / AMEM_BOOTSTRAP_ADMIN_PASSWORD
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.AMEM_BASE_URL || 'http://127.0.0.1:8321').replace(/\/$/, '');
const args = process.argv.slice(2);
function flag(name, fallback = '') {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return fallback;
}

const email = flag('email', process.env.AMEM_BOOTSTRAP_ADMIN_EMAIL || 'admin@localhost');
const password = flag('password', process.env.AMEM_BOOTSTRAP_ADMIN_PASSWORD || 'admin');
const workspace = flag('workspace', process.env.AMEM_WORKSPACE || 'personal');
const name = flag('name', 'codex-auto');
const dry = args.includes('--dry-run');

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-amem-workspace': workspace,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return data;
}

function upsertCodexEnv(pat, ws) {
  const cfgPath = join(homedir(), '.codex', 'config.toml');
  if (!existsSync(cfgPath)) throw new Error(`missing ${cfgPath}`);
  let cfg = readFileSync(cfgPath, 'utf8');

  // Remove previous Amem MCP blocks (order-independent, including orphan .env tables).
  // Tolerate leading whitespace: past runs have inserted blocks with indented headers
  // (e.g. inside [shell_environment_policy.set]), which plain `\n[` / `\n#` misses.
  cfg = cfg.replace(/\n\s*# Amem[^\n]*\n/g, '\n');
  cfg = cfg.replace(
    /\n\s*\[mcp_servers\.amem(?:-stdio)?(?:\.[A-Za-z0-9_]+)?\][\s\S]*?(?=\n\s*\[|$)/g,
    '\n',
  );
  cfg = cfg.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  const block = `
# Amem local memory (HTTP MCP + stdio HTTP-proxy)
[mcp_servers.amem]
url = "http://127.0.0.1:8321/mcp"
startup_timeout_sec = 20

[mcp_servers.amem.http_headers]
Authorization = "Bearer ${pat}"

[mcp_servers.amem-stdio]
command = "node"
args = ["/Users/yuf/Documents/amem/packages/mcp/dist/cli.js"]
cwd = "/Users/yuf/Documents/amem"
startup_timeout_sec = 20

[mcp_servers.amem-stdio.env]
AMEM_BASE_URL = "${BASE}"
AMEM_API_TOKEN = "${pat}"
AMEM_WORKSPACE = "${ws}"
`;

  if (dry) {
    console.log(block);
    return;
  }
  writeFileSync(cfgPath, cfg.trimEnd() + '\n' + block + '\n');
  console.log(`updated ${cfgPath} (HTTP OAuth primary + stdio fallback)`);
}

function saveLocalCopy(pat, ws, meta) {
  const dir = join(homedir(), '.amem');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'codex-pat.json'),
    JSON.stringify(
      { at: new Date().toISOString(), workspace: ws, tokenPrefix: pat.slice(0, 16), ...meta },
      null,
      2,
    ),
  );
  // full token only in restricted file
  writeFileSync(join(dir, 'codex-pat.token'), pat, { mode: 0o600 });
}

async function main() {
  // health
  const health = await api('GET', '/health');
  console.log('amem', health);

  // login or bootstrap
  let token;
  let user;
  try {
    const login = await api('POST', '/auth/login', { email, password, tokenName: name });
    token = login.token;
    user = login.user;
    console.log('login ok', user?.email);
  } catch (e) {
    console.log('login failed, trying bootstrap…', String(e.message || e));
    try {
      const boot = await api('POST', '/auth/bootstrap', { email, password, name: 'Admin' });
      token = boot.token;
      user = boot.user;
      console.log('bootstrap ok', user?.email);
    } catch (e2) {
      // fallback: reuse previously saved PAT if server had a transient DB blip
      const prevPath = join(homedir(), '.amem', 'codex-pat.token');
      if (existsSync(prevPath)) {
        token = readFileSync(prevPath, 'utf8').trim();
        console.log('fallback existing PAT from', prevPath);
        user = { email };
      } else {
        throw e2;
      }
    }
  }

  // ensure workspace list and pick
  const me = await api('GET', '/me', undefined, token);
  const ws =
    (me.workspaces || []).find((w) => w.slug === workspace)?.slug ||
    me.workspace?.slug ||
    'personal';

  // mint dedicated long-lived PAT for codex (login already returned a PAT; mint named one)
  let pat = token;
  try {
    const wsId = (me.workspaces || []).find((w) => w.slug === ws)?.id || me.workspace?.id;
    const minted = await api(
      'POST',
      '/auth/tokens',
      {
        name,
        scopes: ['read', 'write', 'admin'],
        workspaceIds: wsId ? [wsId] : undefined,
        ttlDays: 365,
      },
      token,
    );
    pat = minted.token;
    console.log('minted PAT', minted.prefix + '…', 'id=', minted.id);
  } catch (e) {
    console.log('mint failed, reusing login PAT:', String(e.message || e));
  }

  upsertCodexEnv(pat, ws);
  saveLocalCopy(pat, ws, { email: user?.email || email, name });

  // also update hook env file
  const hookEnv = join(homedir(), '.codex', 'hooks', 'amem.env');
  if (!dry) {
    writeFileSync(
      hookEnv,
      `AMEM_BASE_URL=${BASE}\nAMEM_API_TOKEN=${pat}\nAMEM_WORKSPACE=${ws}\nAMEM_DB_PATH=${process.env.AMEM_DB_PATH || '/Users/yuf/Documents/amem/data/amem.db'}\n`,
      { mode: 0o600 },
    );
    console.log('wrote', hookEnv);
  }

  console.log('\nDone.');
  console.log(`  workspace: ${ws}`);
  console.log(`  PAT prefix: ${pat.slice(0, 18)}…`);
  console.log('  Restart Codex Desktop, then run: codex mcp login amem');
  console.log('  (HTTP OAuth primary; stdio fallback remains as amem-stdio)');
  console.log('  Full token (once): saved to ~/.amem/codex-pat.token');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
