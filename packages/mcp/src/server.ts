import type { AmemConfig, AmemService, Storage, RequestContext } from '@amem/core';
import {
  createService,
  getRequestContext,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_SLUG,
  runWithRequestContextAsync,
} from '@amem/core';
import {
  createSqliteStorageFromPath,
  openDatabase,
  migrate,
  AuthStore,
  OauthStore,
  hashToken,
} from '@amem/db';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { callTool, DESCRIPTIONS, toolSchemas, TOOL_NAMES, ToolError } from './tools.js';
import { createHttpAmemService, httpHealth, shouldUseHttpBackend } from './httpBackend.js';

export interface McpServerHandle {
  server: McpServer;
  close(): Promise<void>;
}

/** Human-friendly title derived from a snake_case tool name. */
function titleOf(name: string): string {
  return name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function invokeTool(
  service: AmemService,
  name: string,
  args: unknown,
  ctx: RequestContext,
): Promise<CallToolResult> {
  try {
    return await runWithRequestContextAsync(ctx, async () =>
      callTool(service, name, (args ?? {}) as Record<string, unknown>),
    );
  } catch (error) {
    if (error instanceof ToolError) {
      return {
        content: [{ type: 'text', text: error.message }],
        isError: true,
        structuredContent: { error: error.errorData },
      };
    }
    throw error;
  }
}


function resolveEnvAuthContext(config: AmemConfig, dbPath: string): RequestContext {
  const workspaceSlug = process.env.AMEM_WORKSPACE || DEFAULT_WORKSPACE_SLUG;
  const zoneRef = (process.env.AMEM_ZONE || '').trim();
  const token = process.env.AMEM_API_TOKEN || process.env.AMEM_PAT || '';
  // Default open context (auth disabled / no token)
  const anon: RequestContext = {
    workspaceId: DEFAULT_WORKSPACE_ID,
    workspaceSlug,
    scopes: ['read', 'write', 'admin'],
    realm: 'anonymous',
    authEnabled: Boolean(config.authEnabled),
  };
  if (!token && !zoneRef) return anon;
  // AMEM_ZONE is an explicit access scope: a misconfigured value must fail
  // loudly at startup instead of silently widening to the whole workspace.
  const envZoneError = (msg: string) =>
    new Error(`AMEM_ZONE='${zoneRef}' ${msg} — fix the env var or unset it`);
  try {
    const db = openDatabase(dbPath);
    migrate(db);
    const auth = new AuthStore(db);
    const oauth = new OauthStore(db);
    // map slug
    const ws = auth.getWorkspaceBySlug(workspaceSlug) || auth.getWorkspaceById(DEFAULT_WORKSPACE_ID);
    if (!ws) {
      db.close();
      return anon;
    }
    // Resolve the env zone scope against the resolved workspace. The zone id
    // lands in ctx.zoneIds so every read/write tool is scoped at the storage
    // layer (get_graph, working_memory, activity, ... — no per-tool params
    // needed); write tools also route into it via resolveZoneForWrite.
    let zoneIds: string[] | undefined;
    if (zoneRef) {
      const row = db
        .prepare(
          `SELECT id FROM zones WHERE workspace_id = ? AND status = 'active' AND (id = ? OR slug = ?)`,
        )
        .get(ws.id, zoneRef, zoneRef) as { id: string } | undefined;
      if (!row) {
        db.close();
        throw envZoneError(`does not match any active zone in workspace '${ws.slug}'`);
      }
      zoneIds = [row.id];
    }
    const withZone = (ctx: RequestContext): RequestContext =>
      zoneIds ? { ...ctx, zoneIds } : ctx;

    if (!token) {
      db.close();
      return withZone({ ...anon, workspaceId: ws.id, workspaceSlug: ws.slug });
    }
    if (config.apiToken && token === config.apiToken) {
      db.close();
      return withZone({
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        scopes: ['read', 'write', 'admin'],
        realm: 'legacy',
        authEnabled: true,
      });
    }
    if (token.startsWith('amem_pat_')) {
      const secret = config.authSecret || '';
      // secret may be file-managed by server; try env or sidecar
      let sec = secret;
      if (!sec) {
        const p = join(dirname(dbPath), '.amem_auth_secret');
        if (existsSync(p)) sec = readFileSync(p, 'utf8').trim();
      }
      if (!sec) {
        db.close();
        return withZone({ ...anon, workspaceId: ws.id, workspaceSlug: ws.slug });
      }
      const pat = auth.findPatByToken(sec, token);
      if (!pat) {
        db.close();
        return withZone({ ...anon, workspaceId: ws.id, workspaceSlug: ws.slug, realm: 'anonymous' });
      }
      const scopes = JSON.parse(pat.scopes || '[]') as string[];
      db.close();
      return withZone({
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        userId: pat.user_id,
        scopes: scopes.length ? scopes : ['read', 'write'],
        realm: 'pat',
        authEnabled: true,
      });
    }
    if (token.startsWith('amem_atk_')) {
      let sec = config.authSecret || '';
      if (!sec) {
        const p = join(dirname(dbPath), '.amem_auth_secret');
        if (existsSync(p)) sec = readFileSync(p, 'utf8').trim();
      }
      if (sec) {
        const row = oauth.findOauthToken(hashToken(sec, token), 'access');
        if (row) {
          const scopes = JSON.parse(row.scopes || '[]') as string[];
          db.close();
          return withZone({
            workspaceId: ws.id,
            workspaceSlug: ws.slug,
            userId: row.user_id,
            scopes: scopes.length ? scopes : ['read', 'write'],
            realm: 'user',
            authEnabled: true,
          });
        }
      }
    }
    db.close();
    return withZone({ ...anon, workspaceId: ws.id, workspaceSlug: ws.slug });
  } catch (error) {
    if (zoneRef && error instanceof Error && error.message.startsWith('AMEM_ZONE=')) throw error;
    return anon;
  }
}


export async function createMcpServer(
  config: AmemConfig,
  opts?: { storage?: Storage; closeStorage?: boolean },
): Promise<McpServerHandle> {
  const useHttp = !opts?.storage && shouldUseHttpBackend();
  let storage: Storage | undefined;
  let closeStorage = false;
  let service: AmemService;
  let authCtx = resolveEnvAuthContext(config, config.dbPath);

  if (useHttp) {
    const baseUrl = (process.env.AMEM_BASE_URL || 'http://127.0.0.1:8321').replace(/\/$/, '');
    const token = process.env.AMEM_API_TOKEN || process.env.AMEM_PAT || config.apiToken || '';
    const workspace = process.env.AMEM_WORKSPACE || authCtx.workspaceSlug;
    const zone = process.env.AMEM_ZONE || authCtx.zoneIds?.[0];
    service = createHttpAmemService({ baseUrl, token, workspace, zone });
    // Probe once so stdio fails fast if server is down.
    try {
      const h = await httpHealth({ baseUrl, token, workspace, zone });
      if (!h.ok) console.error('[amem-mcp] HTTP backend health not ok', h);
      else console.error(`[amem-mcp] HTTP backend → ${baseUrl} (no local SQLite open)`);
    } catch (e) {
      console.error(
        `[amem-mcp] HTTP backend unreachable at ${baseUrl}. Start Amem server/Docker, or set AMEM_HTTP_PROXY=0 for offline SQLite.`,
        e instanceof Error ? e.message : e,
      );
      throw e;
    }
    // Mark context as using remote server
    authCtx = { ...authCtx, realm: token ? 'pat' : authCtx.realm, authEnabled: Boolean(token) || authCtx.authEnabled };
  } else {
    const ownsStorage = !opts?.storage;
    storage = opts?.storage ?? (await createSqliteStorageFromPath(config.dbPath));
    closeStorage = opts?.closeStorage ?? ownsStorage;
    service = await createService(config, storage);
  }

  const server = new McpServer({
    name: 'amem',
    version: '0.1.0',
  });

  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      {
        title: titleOf(name),
        description: DESCRIPTIONS[name],
        inputSchema: toolSchemas[name],
      },
      async (args: unknown) => {
        // health over HTTP should be live
        if (useHttp && name === 'health') {
          const baseUrl = (process.env.AMEM_BASE_URL || 'http://127.0.0.1:8321').replace(/\/$/, '');
          const token = process.env.AMEM_API_TOKEN || process.env.AMEM_PAT || config.apiToken || '';
          const workspace = process.env.AMEM_WORKSPACE || authCtx.workspaceSlug;
          const zone = process.env.AMEM_ZONE || authCtx.zoneIds?.[0];
          try {
            const h = await httpHealth({ baseUrl, token, workspace, zone });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(h) }],
              structuredContent: h as unknown as Record<string, unknown>,
            };
          } catch (error) {
            return {
              content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            };
          }
        }
        // Prefer live HTTP/request ALS (OAuth/PAT per call); fall back to env/stdio context.
        const live = getRequestContext();
        const ctx = live ?? authCtx;
        return invokeTool(service, name, args, ctx);
      },
    );
  }

  return {
    server,
    async close() {
      if (server.isConnected()) {
        await server.close();
      }
      if (closeStorage && storage) {
        await storage.close();
      }
    },
  };
}
