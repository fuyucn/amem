import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type {
  AiProvider,
  AiProviderInput,
  AmemConfig,
  AmemError as AmemErrorType,
  AmemService,
  CompactInput,
  ExportBundle,
  IngestInput,
  NewUnit,
  OcrSettingsInput,
  ProviderTestResult,
  RecallInput,
} from '@amem/core';
import {
  AmemError,
  accessibleZones,
  createEmbedder,
  createLlm,
  createService,
  proposeNewZones,
  recomputeZoneCentroids,
  renderOkfBundle,
  requireRequestContext,
  resolveExplicitZone,
  runWithRequestContextAsync,
  type ProposeZonesOptions,
} from '@amem/core';
import {
  createSqliteStorageFromPath,
  openDatabase,
  migrate,
  seedDefaultZones,
  type SqliteStorage,
} from '@amem/db';
import { createMcpServer } from '@amem/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import {
  hasScope,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_SLUG,
  type RequestContext,
} from '@amem/core';
import {
  bootstrapAuth,
  createAuthStore,
  createOauthStore,
  resolveRequestAuth,
  verifyPassword,
} from './auth.js';
import {
  authHtmlPage,
  issueTokenPair,
  requireRedirectAllowed,
  verifyPkce,
  newOpaqueToken,
} from './oauth.js';
import { bucketForUrl, createRateLimiter, type RateLimiter } from './rateLimit.js';
import { hashToken } from '@amem/db';

export interface ServerHandle {
  app: FastifyInstance;
  url?: string;
  close: () => Promise<void>;
  /** Per-IP throttle for auth endpoints; exposed for tests/ops. */
  rateLimiter: RateLimiter;
}

function statusFor(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'VALIDATION':
      return 400;
    case 'CONFLICT':
      return 409;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'RATE_LIMITED':
      return 429;
    case 'BUSY':
    case 'PROVIDER':
    case 'NOT_CONFIGURED':
      return 503;
    default:
      return 500;
  }
}

/** Serialize a provider without ever exposing the raw API key. */
function maskProvider(p: AiProvider): Record<string, unknown> {
  const { apiKey, embeddingApiKey, ...rest } = p;
  return {
    ...rest,
    hasKey: Boolean(apiKey),
    keyPrefix: apiKey ? `${apiKey.slice(0, 6)}…` : undefined,
    hasEmbeddingKey: Boolean(embeddingApiKey),
  };
}

/**
 * Probe an OpenAI-compatible endpoint. Tries `GET /models` first, then falls
 * back to a 1-token chat completion (some local gateways don't implement
 * `/models`). Never touches the knowledge graph.
 */
async function testProvider(p: AiProvider): Promise<ProviderTestResult> {
  const started = Date.now();
  const base = p.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  const signal = AbortSignal.timeout(10_000);
  try {
    const res = await fetch(`${base}/models`, { headers, signal });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
      const model =
        data?.data?.find((m) => m.id === p.model)?.id ?? p.model;
      return { ok: true, latencyMs: Date.now() - started, model };
    }
  } catch {
    /* fall through to chat completion probe */
  }
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: `LLM API error ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    return { ok: true, latencyMs: Date.now() - started, model: p.model };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Build a Fastify app exposing the Amem REST API (and optionally the web UI).
 * If `opts.listen` is true it also starts listening and returns `url`.
 */
export async function createServer(
  config: AmemConfig,
  opts?: { listen?: boolean },
): Promise<ServerHandle> {
  const authDb = openDatabase(config.dbPath);
  migrate(authDb);
  const authStore = createAuthStore(authDb);
  const oauthStore = createOauthStore(authDb);
  oauthStore.ensureWebClient();
  const boot = bootstrapAuth(authStore, config);
  if (boot.bootstrapToken) {
    console.warn(
      `[amem] auth bootstrap admin=${boot.adminEmail} PAT (save once): ${boot.bootstrapToken}`,
    );
  }
  const authSecret = boot.secret;
  const rateLimiter = createRateLimiter(config.rateLimit);
  const storage: SqliteStorage = await createSqliteStorageFromPath(config.dbPath, authSecret);
  const service: AmemService = await createService(config, storage);
  // Swap the LLM at runtime from Settings; falls back to env → mock.
  const syncLlmFromProvider = async (): Promise<void> => {
    const active = await storage.getActiveProvider();
    service.setLlm(
      createLlm(
        active && active.baseUrl && active.model
          ? { baseUrl: active.baseUrl, model: active.model, apiKey: active.apiKey }
          : config.llm,
      ),
    );
  };
  // Swap the embedder at runtime from Settings; falls back to env → offline.
  const syncEmbedderFromProvider = async (): Promise<void> => {
    const active = await storage.getActiveProvider();
    // Only switch to API embeddings when the user explicitly configured a
    // separate embedding model — chat models usually have no /embeddings route.
    // A dedicated embedding endpoint (embeddingBaseUrl) may be set when the
    // chat provider itself cannot serve embeddings (e.g. gateway aggregators).
    if (active && active.embeddingModel) {
      service.setEmbedder(
        await createEmbedder({
          mode: 'api',
          baseUrl: active.embeddingBaseUrl || active.baseUrl,
          model: active.embeddingModel,
          apiKey: active.embeddingApiKey || active.apiKey,
        }),
      );
    } else {
      service.setEmbedder(await createEmbedder(config.embedding));
    }
  };
  await syncLlmFromProvider();
  await syncEmbedderFromProvider();
  // One McpServer per HTTP session — SDK Protocol allows only one transport.
  type McpSession = {
    transport: StreamableHTTPServerTransport;
    mcp: Awaited<ReturnType<typeof createMcpServer>>;
  };
  const mcpSessions = new Map<string, McpSession>();
  const openMcpSession = async () => createMcpServer(config, { storage, closeStorage: false });

  const app: FastifyInstance = Fastify({
    logger: { level: 'info' },
    // Only trust X-Forwarded-For when the operator opts in (behind a reverse
    // proxy). Off by default so clients can't spoof their rate-limit key.
    trustProxy: Boolean(config.trustProxy),
  });

  // Tolerate empty JSON bodies (POST /curate and friends), while still
  // rejecting malformed JSON as a clean 400 instead of an unhandled 500.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = Object.assign(new Error('Invalid JSON body'), {
        statusCode: 400,
        code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      });
      done(err);
    }
  });

  // Auth + workspace context (ALS enterWith so storage sees workspace_id).
  const { enterRequestContextWithZones, enterRequestContextWithZoneScope } = await import(
    './authContext.js'
  );
  app.addHook('onRequest', async (req, reply) => {
    const url = (req.url || '').split('?')[0] || '';
    const needsAuthContext = url.startsWith('/api/') || url.startsWith('/mcp');
    if (!needsAuthContext) return;

    if (url === '/api/v1/health') {
      enterRequestContextWithZones({
        workspaceId: DEFAULT_WORKSPACE_ID,
        workspaceSlug: DEFAULT_WORKSPACE_SLUG,
        scopes: ['read'],
        realm: 'anonymous',
        authEnabled: Boolean(config.authEnabled),
      }, storage);
      return;
    }

    // Throttle auth/token endpoints per IP (brute force / token spray).
    const rateBucket = bucketForUrl(url);
    if (rateBucket) {
      rateLimiter.check(rateBucket, req.ip);
    }

    // bootstrap is public only when no users yet
    if (
      url === '/api/v1/auth/bootstrap' ||
      url === '/api/v1/auth/login' ||
      url === '/.well-known/oauth-authorization-server' ||
      url.startsWith('/.well-known/oauth-protected-resource') ||
      url === '/oauth/register' ||
      url.startsWith('/oauth/')
    )
      return;

    try {
      const workspaceHeader =
        (req.headers['x-amem-workspace'] as string | undefined) ||
        (req.headers['x-workspace'] as string | undefined);
      const zoneHeader = (req.headers['x-amem-zone'] as string | undefined)?.trim();
      const resolved = resolveRequestAuth({
        config,
        store: authStore,
        oauth: oauthStore,
        secret: authSecret,
        authorization: req.headers.authorization,
        workspaceHeader,
      });
      let ctx = enterRequestContextWithZones(resolved.ctx, storage);
      if (zoneHeader) {
        const scoped = enterRequestContextWithZoneScope(ctx, storage, zoneHeader);
        if (!scoped.ok) {
          return reply.code(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `zone '${zoneHeader}' does not exist or is not accessible in this workspace`,
            },
          });
        }
        ctx = scoped.ctx;
      }
      (req as { amemAuth?: typeof resolved }).amemAuth = { ...resolved, ctx };
    } catch (err) {
      // Only fall open when auth is fully off (no PAT system and no legacy token)
      // AND the request carries no credential and no explicit workspace intent.
      // Otherwise a caller that presented a token / workspace header must get the
      // real auth outcome (401/403) instead of silently leaking the default
      // workspace's data.
      const openMode = !config.authEnabled && !config.apiToken;
      const presentedCredential = Boolean(req.headers.authorization);
      const presentedWorkspace = Boolean(
        req.headers['x-amem-workspace'] || req.headers['x-workspace'],
      );
      if (openMode && !presentedCredential && !presentedWorkspace) {
        enterRequestContextWithZones({
          workspaceId: DEFAULT_WORKSPACE_ID,
          workspaceSlug: DEFAULT_WORKSPACE_SLUG,
          scopes: ['read', 'write', 'admin'],
          realm: 'anonymous',
          authEnabled: false,
        }, storage);
        return;
      }
      // /mcp must reach the handler so it can emit OAuth WWW-Authenticate (RFC 9728).
      if (url.startsWith('/mcp')) {
        const anonCtx: RequestContext = {
          workspaceId: DEFAULT_WORKSPACE_ID,
          workspaceSlug: DEFAULT_WORKSPACE_SLUG,
          scopes: openMode ? ['read', 'write', 'admin'] : [],
          realm: 'anonymous',
          authEnabled: !openMode,
        };
        enterRequestContextWithZones(anonCtx, storage);
        (req as { amemAuth?: { ctx: RequestContext } }).amemAuth = { ctx: anonCtx };
        return;
      }
      if (err instanceof AmemError) {
        return reply
          .code(statusFor(err.code))
          .send({ error: { code: err.code, message: err.message } });
      }
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    }
  });

  if (config.corsOrigin) {
    await app.register(cors, { origin: config.corsOrigin });
  }

  // Central error -> JSON error shape.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AmemError) {
      return reply
        .code(statusFor(err.code))
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    reqLog(app).error?.({ err }, 'unhandled error');
    if (typeof (err as { statusCode?: number }).statusCode === 'number') {
      const code = (err as { statusCode: number }).statusCode;
      const message = err instanceof Error ? err.message : 'Request error';
      return reply.code(code).send({ error: { code: 'REQUEST', message } });
    }
    const msg = err instanceof Error ? err.message : 'Internal error';
    return reply.code(500).send({ error: { code: 'INTERNAL', message: msg } });
  });

  const api = async (fastify: FastifyInstance) => {
    fastify.get('/health', async () => service.health());
    fastify.get('/admin/db-health', async (req) => {
      // Prefer admin/PAT when auth is on; still allow local open mode.
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (resolved?.ctx.authEnabled && resolved.ctx.realm === 'anonymous') {
        throw new AmemError('UNAUTHORIZED', 'auth required for db-health');
      }
      if (resolved?.ctx.authEnabled && resolved.ctx.userId && !hasScope(resolved.ctx, 'admin')) {
        // allow write+ too for ops convenience
        if (!hasScope(resolved.ctx, 'write')) {
          throw new AmemError('UNAUTHORIZED', 'write or admin scope required');
        }
      }
      // Probe on the server's own connection: a second connection doing
      // `PRAGMA journal_mode` can fail with SQLITE_IOERR on bind-mounted
      // filesystems (e.g. virtiofs on macOS Docker) while the main writer is live.
      const health = await storage.dbHealth();
      return {
        ok: health.ok,
        status: health.status,
        journal: health.journal,
        units: health.units,
        dbPath: config.dbPath,
        hint: 'Health probe runs on the server main connection. Do not run host sqlite3 against a bind-mounted DB while Docker Amem is up.',
      };
    });
    fastify.post<{ Body: IngestInput & { zone?: string } }>('/ingest', async (req) => {
      // REST convention uses `zone` (id or slug) like /recall and /search;
      // normalize it to the service-level `zoneId` so a slug never leaks into
      // the units table and an explicit partition is never silently ignored.
      const { zone, ...rest } = req.body;
      return service.ingest(zone ? { ...rest, zoneId: zone } : (rest as IngestInput));
    });
    fastify.post<{ Body?: { dryRun?: boolean } }>('/admin/reembed', async (req) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (resolved?.ctx.authEnabled && resolved.ctx.realm === 'anonymous') {
        throw new AmemError('UNAUTHORIZED', 'auth required for reembed');
      }
      if (
        resolved?.ctx.authEnabled &&
        resolved.ctx.userId &&
        !hasScope(resolved.ctx, 'admin')
      ) {
        throw new AmemError('UNAUTHORIZED', 'admin scope required for reembed');
      }
      const result = await service.reembedAll({ dryRun: req.body?.dryRun });
      storage
        .recordEvent({
          kind: 'maintenance_reembed',
          summary: `Re-embed ${result.updated}/${result.scanned} units (${result.mode})`,
          actor: resolved?.ctx.userId ?? 'amem',
          meta: result,
        })
        .catch(() => {});
      return result;
    });
    fastify.post('/compact', async (req) => service.compact(req.body as CompactInput));
    fastify.post<{ Body: RecallInput }>('/recall', async (req) =>
      service.recall({
        query: req.body.query,
        tokenBudget: req.body.tokenBudget,
        topK: req.body.topK,
        includeBody: req.body.includeBody,
        zone: req.body.zone,
        crossZone: req.body.crossZone,
      }),
    );
    fastify.post<{ Body: RecallInput }>('/recall/layered', async (req) =>
      service.recallLayered({
        query: req.body.query,
        tokenBudget: req.body.tokenBudget,
        topK: req.body.topK,
        includeBody: req.body.includeBody,
        zone: req.body.zone,
        crossZone: req.body.crossZone,
      }),
    );
    fastify.get<{
      Querystring: {
        q: string;
        limit?: string;
        offset?: string;
        type?: string;
        category?: string;
        tag?: string;
        status?: string;
        fullText?: string;
        zone?: string;
      };
    }>('/search', async (req) =>
      service.search(req.query.q, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
        type: req.query.type as never,
        category: req.query.category,
        tag: req.query.tag,
        status: req.query.status as never,
        fullText: req.query.fullText === '1' || req.query.fullText === 'true',
        zone: req.query.zone,
      }),
    );

    fastify.get<{ Querystring: Record<string, string | undefined> }>('/units', async (req) => {
      const zoneRef = req.query.zone;
      const zoneId = zoneRef
        ? (await storage.listZones()).find((z) => z.id === zoneRef || z.slug === zoneRef)?.id
        : undefined;
      return service.listUnits({
        type: req.query.type as NewUnit['type'],
        status: req.query.status as NewUnit['status'],
        tag: req.query.tag,
        agent: req.query.agent,
        category: req.query.category,
        zoneId,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
    });
    fastify.get('/library/tree', async () => storage.libraryTree());
    fastify.get('/agents', async () => storage.listAgents());
    fastify.post<{ Body: { ids?: string[]; mode?: 'rules' | 'llm' | 'auto'; reclassify?: boolean } }>(
      '/units/classify',
      async (req) => service.classifyUnits(req.body ?? {}),
    );
    fastify.post<{ Body: { ids: string[]; action: 'archive' | 'restore' | 'delete' | 'accept' } }>(
      '/units/batch',
      async (req) => {
        const { ids, action } = req.body ?? { ids: [], action: 'archive' };
        if (!Array.isArray(ids) || ids.length === 0) {
          throw new AmemError('VALIDATION', 'batch requires a non-empty ids array');
        }
        return service.batchUnits({ ids, action });
      },
    );
    fastify.get<{ Params: { id: string } }>('/units/:id', async (req) => {
      const unit = await service.getUnit(req.params.id);
      if (!unit) throw new AmemError('NOT_FOUND', `Unit not found: ${req.params.id}`);
      return unit;
    });
    fastify.post<{ Body: NewUnit & { unit?: NewUnit; zone?: string } }>('/units', async (req) => {
      // REST convention uses `zone` (id or slug) like /ingest, /recall and
      // /search; normalize it to the service-level `zoneId` so a slug never
      // leaks into the units table and an explicit partition is never ignored.
      const { zone, ...rest } = req.body || ({} as NewUnit & { unit?: NewUnit; zone?: string });
      const unit = (rest.unit ? rest.unit : rest) as NewUnit;
      if (!unit || !unit.title) throw new AmemError('VALIDATION', 'unit.title required');
      return service.saveUnit(zone ? { ...unit, zoneId: zone } : unit);
    });
    fastify.patch<{ Params: { id: string }; Body: { patch: Partial<NewUnit>; reason?: string } }>(
      '/units/:id',
      async (req) => service.updateUnit(req.params.id, req.body.patch, req.body.reason),
    );
    fastify.delete<{ Params: { id: string } }>('/units/:id', async (req) => {
      await service.deleteUnit(req.params.id);
      return null;
    });
    fastify.post<{ Params: { id: string }; Body: { action: 'accept' | 'discard' } }>(
      '/units/:id/review',
      async (req) => service.reviewUnit(req.params.id, req.body.action),
    );

    // --- Zones: partitions + ACL (project scoping inside a workspace) ---
    const zoneAuth = (req: object) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (!resolved?.ctx.userId) throw new AmemError('UNAUTHORIZED', 'login/PAT required');
      if (!hasScope(resolved.ctx, 'write')) {
        throw new AmemError('UNAUTHORIZED', 'write scope required');
      }
      return resolved.ctx;
    };

    fastify.get('/zones', async (req) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      const ctx = resolved?.ctx ?? requireRequestContext();
      const zones = await accessibleZones(storage, ctx);
      const members = new Map<string, number>();
      const unitCounts = new Map<string, number>();
      const units = await storage.allUnits();
      for (const z of zones) {
        members.set(z.id, (await storage.listZoneMembers(z.id)).length);
        unitCounts.set(z.id, units.filter((u) => u.zoneId === z.id).length);
      }
      return zones.map((z) => ({
        ...z,
        memberCount: members.get(z.id) ?? 0,
        unitCount: unitCounts.get(z.id) ?? 0,
      }));
    });

    fastify.post<{
      Body: {
        slug?: string;
        name?: string;
        kind?: 'personal' | 'shared' | 'project' | 'inbox';
        visibility?: 'private' | 'workspace' | 'members';
        description?: string;
      };
    }>('/zones', async (req) => {
      const ctx = zoneAuth(req);
      const slug = String(req.body.slug || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-|-$/g, '');
      if (!slug) throw new AmemError('VALIDATION', 'slug required');
      const name = req.body.name?.trim() || slug;
      const kind = req.body.kind ?? 'project';
      if (!['personal', 'shared', 'project', 'inbox'].includes(kind)) {
        throw new AmemError('VALIDATION', `invalid kind: ${kind}`);
      }
      const visibility = req.body.visibility ?? (kind === 'project' ? 'private' : 'workspace');
      if (!['private', 'workspace', 'members'].includes(visibility)) {
        throw new AmemError('VALIDATION', `invalid visibility: ${visibility}`);
      }
      const existing = (await storage.listZones()).find((z) => z.slug === slug);
      if (existing) throw new AmemError('CONFLICT', `zone slug "${slug}" already exists`);
      const zone = await storage.createZone({
        workspaceId: ctx.workspaceId,
        slug,
        name,
        kind,
        visibility,
        description: req.body.description?.trim() || undefined,
        ownerUserId: ctx.userId,
        auto: false,
      });
      if (visibility !== 'workspace') {
        await storage.addZoneMember(zone.id, ctx.userId as string, 'owner');
      }
      storage
        .recordEvent({
          kind: 'zone_create',
          summary: `Zone ${slug} created (${kind})`,
          actor: ctx.userId,
          meta: { slug, name, kind, visibility, zoneId: zone.id },
        })
        .catch(() => {});
      return zone;
    });

    fastify.patch<{
      Params: { id: string };
      Body: {
        name?: string;
        visibility?: 'private' | 'workspace' | 'members';
        description?: string;
        status?: 'active' | 'archived';
      };
    }>('/zones/:id', async (req) => {
      zoneAuth(req);
      const zone = await storage.getZone(req.params.id);
      if (!zone) throw new AmemError('NOT_FOUND', `Zone not found: ${req.params.id}`);
      const next = {
        ...zone,
        name: req.body.name?.trim() || zone.name,
        visibility: req.body.visibility ?? zone.visibility,
        description: req.body.description !== undefined ? req.body.description : zone.description,
        status: req.body.status ?? zone.status,
        updatedAt: new Date().toISOString(),
      };
      await storage.updateZone(next);
      return next;
    });

    fastify.delete<{ Params: { id: string } }>('/zones/:id', async (req) => {
      zoneAuth(req);
      const zone = await storage.getZone(req.params.id);
      if (!zone) throw new AmemError('NOT_FOUND', `Zone not found: ${req.params.id}`);
      const units = (await storage.allUnits()).filter((u) => u.zoneId === zone.id);
      if (units.length > 0) {
        throw new AmemError(
          'CONFLICT',
          `zone ${zone.slug} still holds ${units.length} unit(s); move them first`,
        );
      }
      await storage.deleteZone(zone.id);
      return { ok: true, zoneId: zone.id };
    });

    fastify.get<{ Params: { id: string } }>('/zones/:id/members', async (req) => {
      zoneAuth(req);
      const zone = await storage.getZone(req.params.id);
      if (!zone) throw new AmemError('NOT_FOUND', `Zone not found: ${req.params.id}`);
      return storage.listZoneMembers(zone.id);
    });

    fastify.post<{
      Params: { id: string };
      Body: { userId?: string; email?: string; role?: 'owner' | 'editor' | 'reader' };
    }>('/zones/:id/members', async (req) => {
      const ctx = zoneAuth(req);
      const zone = await storage.getZone(req.params.id);
      if (!zone) throw new AmemError('NOT_FOUND', `Zone not found: ${req.params.id}`);
      let userId = req.body?.userId;
      if (!userId && req.body?.email) {
        const user = authStore.getUserByEmail(req.body.email);
        userId = user?.id;
      }
      if (!userId) throw new AmemError('VALIDATION', 'userId or email required');
      const role = req.body?.role ?? 'reader';
      if (!['owner', 'editor', 'reader'].includes(role)) {
        throw new AmemError('VALIDATION', `invalid role: ${role}`);
      }
      await storage.addZoneMember(zone.id, userId, role);
      storage
        .recordEvent({
          kind: 'zone_member_add',
          summary: `Member ${userId} added to zone ${zone.slug} as ${role}`,
          actor: ctx.userId,
          meta: { zoneId: zone.id, userId, role },
        })
        .catch(() => {});
      return { ok: true, zoneId: zone.id, userId, role };
    });

    fastify.delete<{ Params: { id: string; userId: string } }>(
      '/zones/:id/members/:userId',
      async (req) => {
        zoneAuth(req);
        const zone = await storage.getZone(req.params.id);
        if (!zone) throw new AmemError('NOT_FOUND', `Zone not found: ${req.params.id}`);
        await storage.removeZoneMember(zone.id, req.params.userId);
        return { ok: true, zoneId: zone.id, userId: req.params.userId };
      },
    );

    fastify.post('/zones/recompute', async (req) => {
      zoneAuth(req);
      return recomputeZoneCentroids(storage, service.getEmbedder());
    });

    fastify.post<{ Body?: ProposeZonesOptions }>('/zones/proposals', async (req) => {
      zoneAuth(req);
      return proposeNewZones(storage, service.getEmbedder(), req.body ?? {});
    });

    fastify.post<{ Params: { id: string }; Body: { zoneId?: string; zoneSlug?: string } }>(
      '/units/:id/zone',
      async (req) => {
        const ctx = zoneAuth(req);
        const zoneRef = req.body?.zoneId ?? req.body?.zoneSlug;
        if (!zoneRef) throw new AmemError('VALIDATION', 'zoneId or zoneSlug required');
        const unit = await service.getUnit(req.params.id);
        if (!unit) throw new AmemError('NOT_FOUND', `Unit not found: ${req.params.id}`);
        const routed = await resolveExplicitZone(zoneRef, storage, ctx);
        if (!routed) throw new AmemError('NOT_FOUND', `Zone not found or not accessible: ${zoneRef}`);
        await storage.moveUnitZone(unit.id, routed.id);
        storage
          .recordEvent({
            kind: 'zone_move',
            summary: `Unit "${unit.title.slice(0, 60)}" moved to ${routed.slug}`,
            actor: ctx.userId,
            meta: { unitId: unit.id, zoneId: routed.id },
          })
          .catch(() => {});
        return { ok: true, unitId: unit.id, zoneId: routed.id, zoneSlug: routed.slug };
      },
    );

    fastify.get<{ Querystring: { clusters?: string; scenarios?: string } }>('/graph', async (req) =>
      service.getGraph(req.query.clusters === '1', req.query.scenarios === '1'),
    );
    fastify.get<{ Params: { unitId: string } }>('/links/:unitId', async (req) =>
      service.getLinksForUnit(req.params.unitId),
    );
    fastify.post<{ Body: Parameters<AmemService['linkUnits']>[0] }>('/links', async (req) =>
      service.linkUnits(req.body),
    );
    fastify.post<{ Body: { maxPerUnit?: number; dryRun?: boolean } }>('/links/prune', async (req) =>
      service.pruneAutoLinks(req.body ?? {}),
    );

    fastify.get('/traces', async () => service.getTraces());
    fastify.get<{ Params: { id: string } }>('/traces/:id', async (req) => {
      const trace = await service.getTrace(req.params.id);
      if (!trace) throw new AmemError('NOT_FOUND', `Trace not found: ${req.params.id}`);
      return trace;
    });
    fastify.delete<{ Body?: { ids?: string[]; before?: string; all?: boolean } }>('/traces', async (req) => {
      // Admin-only audit hygiene: purge probe/test noise from the trace log.
      // Requires an explicit filter (ids / before) or all:true — no accidental
      // full wipe. Traces are raw material, never secrets.
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (!resolved?.ctx.userId || !hasScope(resolved.ctx, 'admin')) {
        throw new AmemError('FORBIDDEN', 'admin scope required to purge traces');
      }
      const body = req.body ?? {};
      const { ids, before, all } = body;
      if ((!ids || ids.length === 0) && !before && !all) {
        throw new AmemError('VALIDATION', 'provide ids, before, or all:true');
      }
      const deleted = await service.deleteTraces({ ids, before, all });
      await storage.recordEvent({
        kind: 'admin_trace_purge',
        summary: `Purged ${deleted} trace(s)`,
        actor: resolved.ctx.userId,
        meta: { ids: ids?.length ?? 0, before: before ?? null, all: !!all, deleted },
      });
      return { ok: true, deleted };
    });
    fastify.get<{ Querystring: { date?: string; budget?: number } }>(
      '/working-memory',
      async (req) => service.workingMemory(req.query.date, req.query.budget),
    );
    fastify.get<{ Querystring: { tag?: string; status?: string; limit?: string; sort?: string } }>(
      '/scenarios',
      async (req) =>
        service.listScenarios({
          tag: req.query.tag,
          status: req.query.status as 'active' | 'stale' | 'archived' | undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          sort: req.query.sort === 'heat' || req.query.sort === 'updated' ? req.query.sort : undefined,
        }),
    );
    fastify.get<{ Params: { id: string } }>('/scenarios/:id', async (req) => {
      const scenario = await service.getScenario(req.params.id);
      if (!scenario) throw new AmemError('NOT_FOUND', `Scenario not found: ${req.params.id}`);
      return scenario;
    });
    fastify.post<{ Body: { tags?: string[]; forcePersona?: boolean; maxScenarios?: number; mode?: 'fast' | 'auto' | 'full' } }>(
      '/layers/refresh',
      async (req) => service.refreshLayers(req.body ?? {}),
    );
    fastify.post<{ Body: { mode?: 'fast' | 'auto' | 'full' } }>(
      '/layers/precipitate',
      async (req) => service.autoPrecipitate(req.body ?? {}),
    );
    fastify.get('/persona', async () => service.getPersona());
    fastify.get<{ Querystring: { kind?: string; status?: string; limit?: string } }>(
      '/assets',
      async (req) =>
        service.listAssets({
          kind: req.query.kind as 'skill' | 'wiki' | 'codegraph' | 'prompt' | undefined,
          status: req.query.status as 'draft' | 'reviewed' | 'published' | 'archived' | undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        }),
    );
    fastify.get<{ Params: { id: string } }>('/assets/:id', async (req) => {
      const asset = await service.getAsset(req.params.id);
      if (!asset) throw new AmemError('NOT_FOUND', `Asset not found: ${req.params.id}`);
      return asset;
    });
    fastify.get<{ Params: { id: string } }>('/assets/:id/versions', async (req) => {
      const asset = await service.getAsset(req.params.id);
      if (!asset) throw new AmemError('NOT_FOUND', `Asset not found: ${req.params.id}`);
      return service.listAssetVersions(req.params.id);
    });
    fastify.get<{ Querystring: { agent: string } }>('/assets/equipped', async (req) => {
      const agent = req.query.agent;
      if (!agent) throw new AmemError('VALIDATION', 'Query param "agent" is required');
      return service.listEquipped(agent);
    });
    fastify.post<{
      Body: { task: string; agent?: string; kind?: 'skill' | 'wiki' | 'codegraph' | 'prompt'; limit?: number };
    }>('/assets/route', async (req) => {
      const task = req.body?.task;
      if (!task || typeof task !== 'string') {
        throw new AmemError('VALIDATION', 'Body field "task" is required');
      }
      return service.routeAssets({
        task,
        agent: req.body?.agent,
        kind: req.body?.kind,
        limit: req.body?.limit,
      });
    });
    fastify.post<{
      Params: { id: string };
      Body: { agent?: string; query?: string; budget?: number };
    }>('/assets/:id/call', async (req) =>
      service.callAsset({
        id: req.params.id,
        agent: req.body?.agent,
        query: req.body?.query,
        budget: req.body?.budget,
      }),
    );
    fastify.post<{ Body: { asset: Parameters<AmemService['saveAsset']>[0] } }>(
      '/assets',
      async (req) => service.saveAsset(req.body.asset),
    );
    fastify.patch<{
      Params: { id: string };
      Body: { patch: Parameters<AmemService['updateAsset']>[1]; reason?: string };
    }>('/assets/:id', async (req) => service.updateAsset(req.params.id, req.body.patch, req.body.reason));
    fastify.delete<{ Params: { id: string } }>('/assets/:id', async (req) => {
      await service.deleteAsset(req.params.id);
      return null;
    });
    fastify.post<{ Body: { limit?: number; includePending?: boolean } }>(
      '/skills/extract',
      async (req) => service.extractSkills(req.body ?? {}),
    );
    fastify.post<{ Body: { limit?: number } }>(
      '/assets/extract/codegraph',
      async (req) => service.extractCodegraph(req.body ?? {}),
    );
    fastify.post<{ Body: { limit?: number } }>(
      '/assets/extract/wiki',
      async (req) => service.extractWiki(req.body ?? {}),
    );
    fastify.post<{ Body: Parameters<AmemService['importDirectory']>[0] }>(
      '/import/directory',
      async (req) => service.importDirectory(req.body),
    );
    fastify.post<{ Body: Parameters<AmemService['importPdf']>[0] }>(
      '/import/pdf',
      async (req) => service.importPdf(req.body),
    );
    fastify.post<{
      Body: { filename: string; contentBase64: string; extract?: boolean; zone?: string };
    }>('/ingest/file', async (req) => {
      const { filename, contentBase64, extract, zone } = req.body;
      if (!filename || !contentBase64) {
        throw new AmemError('VALIDATION', 'filename and contentBase64 are required');
      }
      if (/\.pdf$/i.test(filename)) {
        return service.importPdf({ filename, contentBase64, extract, zone });
      }
      const content = Buffer.from(contentBase64, 'base64').toString('utf8').trim();
      if (!content) throw new AmemError('VALIDATION', 'file is empty or not decodable as UTF-8 text');
      const result = await service.ingest({
        title: filename,
        content,
        contentType: 'text/plain',
        sourceUri: filename,
        sourceKind: 'file',
        extract: extract ?? true,
        zoneId: zone,
      });
      return {
        units: result.units.length,
        traces: 1,
        links: 0,
        sources: 1,
        files: 1,
        sessions: 0,
        tokensSavedByDedup: result.tokensSavedByDedup,
      };
    });
    fastify.post<{ Body: Parameters<AmemService['importCodebase']>[0] }>(
      '/import/codebase',
      async (req) => service.importCodebase(req.body),
    );
    fastify.post<{ Body: Parameters<AmemService['importSessions']>[0] }>(
      '/import/sessions',
      async (req) => service.importSessions(req.body),
    );
    fastify.post<{ Body: Parameters<AmemService['seed']>[0] }>(
      '/seed',
      async (req) => service.seed(req.body),
    );
    fastify.post<{ Body?: { preset?: 'fast' | 'full' } }>('/curate', async (req) =>
      service.curate(req.body?.preset || 'fast'),
    );
    fastify.get('/stats', async () => service.stats());
    fastify.get<{ Querystring: { hours?: string; limit?: string } }>('/activity/summary', async (req) =>
      service.activitySummary({
        hours: req.query.hours ? Number(req.query.hours) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    );
    fastify.get<{ Querystring: { kind?: string; limit?: string } }>('/activity', async (req) =>
      service.activity({
        kind: req.query.kind,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    );
    fastify.get<{ Querystring: { limit?: string } }>('/pipeline', async (req) =>
      service.pipeline(req.query.limit ? Number(req.query.limit) : undefined),
    );
    fastify.get('/export', async () => service.export());
    fastify.post<{ Body: ExportBundle }>('/import', async (req) => service.import(req.body));
    fastify.get('/export/okf', async () => {
      const files: Record<string, string> = {};
      for (const [name, content] of renderOkfBundle(await service.export())) files[name] = content;
      return { files };
    });

    // --- Auth / workspaces (PAT MVP) ---

    fastify.post<{ Body: { email: string; password: string; tokenName?: string } }>(
      '/auth/login',
      async (req) => {
        const email = String(req.body?.email || '');
        const password = String(req.body?.password || '');
        const user = authStore.getUserByEmail(email);
        if (!user || !verifyPassword(password, user.password_hash)) {
          storage
            .recordEvent({
              kind: 'auth_login_failed',
              summary: `Failed login attempt for ${email}`,
              actor: email,
            })
            .catch(() => {});
          throw new AmemError('UNAUTHORIZED', 'Invalid credentials');
        }
        const workspaces = authStore.listWorkspacesForUser(user.id);
        const wsIds = workspaces.map((w) => w.id);
        const { token, row } = authStore.createPat({
          userId: user.id,
          name: req.body.tokenName || 'login',
          scopes: ['read', 'write', 'admin'],
          workspaceIds: wsIds.length ? wsIds : [DEFAULT_WORKSPACE_ID],
          secret: authSecret,
          ttlDays: config.patDefaultTtlDays ?? 90,
        });
        storage
          .recordEvent({ kind: 'auth_login', summary: `User ${email} logged in`, actor: email })
          .catch(() => {});
        return {
          user: { id: user.id, email: user.email, name: user.name },
          token,
          tokenId: row.id,
          workspaces: workspaces.map((w) => ({
            id: w.id,
            slug: w.slug,
            name: w.name,
            kind: w.kind,
          })),
        };
      },
    );

    fastify.post<{ Body: { email?: string; password?: string; name?: string } }>(
      '/auth/bootstrap',
      async (req) => {
        if (authStore.countUsers() > 0) {
          throw new AmemError('CONFLICT', 'Already bootstrapped');
        }
        const email = req.body?.email || config.bootstrapAdminEmail || 'admin@localhost';
        const password = req.body?.password || config.bootstrapAdminPassword || 'admin';
        const user = authStore.createUser({ email, password, name: req.body?.name || 'Admin' });
        const ws = authStore.ensurePersonalWorkspace(user.id, 'Personal');
        const { token, row } = authStore.createPat({
          userId: user.id,
          name: 'bootstrap',
          scopes: ['read', 'write', 'admin'],
          workspaceIds: [ws.id],
          secret: authSecret,
          ttlDays: config.patDefaultTtlDays ?? 90,
        });
        storage
          .recordEvent({
            kind: 'auth_bootstrap',
            summary: `Bootstrap ${user.email}`,
            actor: user.email,
          })
          .catch(() => {});
        return {
          user: { id: user.id, email: user.email },
          workspace: { id: ws.id, slug: ws.slug, name: ws.name },
          token,
          tokenId: row.id,
          authEnabled: Boolean(config.authEnabled),
        };
      },
    );

    fastify.get('/me', async (req) => {
      const resolved = (
        req as {
          amemAuth?: { ctx: RequestContext; workspace: { id: string; slug: string; name: string } };
        }
      ).amemAuth;
      if (!resolved) {
        return {
          realm: 'anonymous',
          authEnabled: Boolean(config.authEnabled),
          workspace: { id: DEFAULT_WORKSPACE_ID, slug: DEFAULT_WORKSPACE_SLUG, name: 'Personal' },
          scopes: ['read', 'write', 'admin'],
        };
      }
      const user = resolved.ctx.userId ? authStore.getUserById(resolved.ctx.userId) : null;
      const workspaces = resolved.ctx.userId
        ? authStore.listWorkspacesForUser(resolved.ctx.userId).map((w) => ({
            id: w.id,
            slug: w.slug,
            name: w.name,
            kind: w.kind,
          }))
        : [
            {
              id: resolved.workspace.id,
              slug: resolved.workspace.slug,
              name: resolved.workspace.name,
            },
          ];
      return {
        realm: resolved.ctx.realm,
        authEnabled: resolved.ctx.authEnabled,
        user: user ? { id: user.id, email: user.email, name: user.name } : null,
        workspace: {
          id: resolved.workspace.id,
          slug: resolved.workspace.slug,
          name: resolved.workspace.name,
        },
        scopes: resolved.ctx.scopes,
        workspaces,
      };
    });

    fastify.get('/workspaces', async (req) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (resolved?.ctx.userId) {
        return authStore.listWorkspacesForUser(resolved.ctx.userId).map((w) => ({
          id: w.id,
          slug: w.slug,
          name: w.name,
          kind: w.kind,
        }));
      }
      const ws = authStore.getWorkspaceById(DEFAULT_WORKSPACE_ID);
      return ws
        ? [{ id: ws.id, slug: ws.slug, name: ws.name, kind: ws.kind }]
        : [
            {
              id: DEFAULT_WORKSPACE_ID,
              slug: DEFAULT_WORKSPACE_SLUG,
              name: 'Personal',
              kind: 'personal',
            },
          ];
    });

    fastify.post<{ Body: { slug: string; name: string; kind?: 'personal' | 'company' } }>(
      '/workspaces',
      async (req) => {
        const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
        if (!resolved?.ctx.userId || !hasScope(resolved.ctx, 'admin')) {
          throw new AmemError('UNAUTHORIZED', 'admin scope required');
        }
        const slug = String(req.body.slug || '')
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-|-$/g, '');
        if (!slug) throw new AmemError('VALIDATION', 'slug required');
        let ws;
        try {
          ws = authStore.createWorkspace({
            slug,
            name: req.body.name || slug,
            kind: req.body.kind === 'company' ? 'company' : 'personal',
            ownerUserId: resolved.ctx.userId,
          });
        } catch (err) {
          // Duplicate slug must be a 409 CONFLICT (idempotent clients retry),
          // not an unhandled 500 from the UNIQUE constraint.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('UNIQUE constraint failed') && msg.includes('workspaces.slug')) {
            throw new AmemError('CONFLICT', `workspace slug "${slug}" already exists`);
          }
          throw err;
        }
        // Every workspace gets the default partition skeleton (inbox/shared +
        // the owner's personal zone); writes 500 without an inbox.
        seedDefaultZones(authDb, ws.id);
        storage
          .recordEvent({
            kind: 'workspace_create',
            summary: `Workspace ${ws.slug} created`,
            actor: resolved.ctx.userId,
            meta: { slug: ws.slug, name: ws.name },
          })
          .catch(() => {});
        return { id: ws.id, slug: ws.slug, name: ws.name, kind: ws.kind };
      },
    );

    const requireWorkspaceAdmin = (req: object, workspaceKey: string) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (!resolved?.ctx.userId) throw new AmemError('UNAUTHORIZED', 'login/PAT required');
      const ws =
        authStore.getWorkspaceById(workspaceKey) || authStore.getWorkspaceBySlug(workspaceKey);
      if (!ws) throw new AmemError('NOT_FOUND', 'workspace not found');
      const role = authStore.memberRole(ws.id, resolved.ctx.userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        throw new AmemError('UNAUTHORIZED', 'workspace admin required');
      }
      return { resolved, ws, role };
    };

    fastify.get<{ Params: { key: string } }>('/workspaces/:key/members', async (req) => {
      const { ws } = requireWorkspaceAdmin(req, req.params.key);
      return authStore.listMembers(ws.id);
    });

    fastify.post<{
      Params: { key: string };
      Body: { email?: string; role?: string };
    }>('/workspaces/:key/members', async (req) => {
      const { ws, resolved } = requireWorkspaceAdmin(req, req.params.key);
      const email = req.body?.email;
      if (!email) throw new AmemError('VALIDATION', 'email required');
      const user = authStore.getUserByEmail(email);
      if (!user)
        throw new AmemError('NOT_FOUND', 'user not found — user must login/bootstrap first');
      const role = (req.body?.role || 'member') as 'owner' | 'admin' | 'member' | 'reader';
      if (!['owner', 'admin', 'member', 'reader'].includes(role)) {
        throw new AmemError('VALIDATION', 'invalid role');
      }
      authStore.upsertMember(ws.id, user.id, role);
      // New members need their personal zone; idempotent (INSERT OR IGNORE).
      seedDefaultZones(authDb, ws.id);
      storage
        .recordEvent({
          kind: 'workspace_member_add',
          summary: `Member ${email} added to ${ws.slug} as ${role}`,
          actor: resolved.ctx.userId,
          meta: { email, role, workspaceSlug: ws.slug },
        })
        .catch(() => {});
      return { ok: true, workspaceId: ws.id, userId: user.id, email: user.email, role };
    });

    fastify.put<{
      Params: { key: string; userId: string };
      Body: { role?: string };
    }>('/workspaces/:key/members/:userId', async (req) => {
      const { ws } = requireWorkspaceAdmin(req, req.params.key);
      const role = (req.body?.role || 'member') as 'owner' | 'admin' | 'member' | 'reader';
      if (!['owner', 'admin', 'member', 'reader'].includes(role)) {
        throw new AmemError('VALIDATION', 'invalid role');
      }
      const user = authStore.getUserById(req.params.userId);
      if (!user) throw new AmemError('NOT_FOUND', 'user not found');
      authStore.upsertMember(ws.id, user.id, role);
      return { ok: true, workspaceId: ws.id, userId: user.id, role };
    });

    fastify.delete<{ Params: { key: string; userId: string } }>(
      '/workspaces/:key/members/:userId',
      async (req) => {
        const { ws, resolved } = requireWorkspaceAdmin(req, req.params.key);
        if (req.params.userId === resolved.ctx.userId) {
          throw new AmemError('VALIDATION', 'cannot remove yourself');
        }
        const ok = authStore.removeMember(ws.id, req.params.userId);
        if (!ok) throw new AmemError('NOT_FOUND', 'member not found');
        storage
          .recordEvent({
            kind: 'workspace_member_remove',
            summary: `Member ${req.params.userId} removed from ${ws.slug}`,
            actor: resolved.ctx.userId,
            meta: { userId: req.params.userId, workspaceSlug: ws.slug },
          })
          .catch(() => {});
        return { ok: true };
      },
    );

    fastify.post<{
      Body: { name?: string; scopes?: string[]; workspaceIds?: string[]; ttlDays?: number };
    }>('/auth/tokens', async (req) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (!resolved?.ctx.userId) throw new AmemError('UNAUTHORIZED', 'login/PAT required');
      const scopes = req.body.scopes?.length ? req.body.scopes : ['read', 'write'];
      const workspaceIds = req.body.workspaceIds?.length
        ? req.body.workspaceIds
        : [resolved.ctx.workspaceId];
      const { token, row } = authStore.createPat({
        userId: resolved.ctx.userId,
        name: req.body.name || 'token',
        scopes,
        workspaceIds,
        secret: authSecret,
        ttlDays: req.body.ttlDays ?? config.patDefaultTtlDays ?? 90,
      });
      storage
        .recordEvent({
          kind: 'auth_token_create',
          summary: `Token "${row.name}" created`,
          actor: resolved.ctx.userId,
          meta: { tokenName: row.name, scopes, workspaceIds },
        })
        .catch(() => {});
      return {
        id: row.id,
        name: row.name,
        token,
        prefix: row.token_prefix,
        scopes,
        workspaceIds,
        expiresAt: row.expires_at,
      };
    });

    fastify.get('/auth/tokens', async (req) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (!resolved?.ctx.userId) throw new AmemError('UNAUTHORIZED', 'login/PAT required');
      return authStore.listPats(resolved.ctx.userId).map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.token_prefix,
        scopes: JSON.parse(r.scopes || '[]'),
        workspaceIds: JSON.parse(r.workspace_ids || '[]'),
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        expiresAt: r.expires_at,
      }));
    });

    fastify.delete<{ Params: { id: string } }>('/auth/tokens/:id', async (req) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (!resolved?.ctx.userId) throw new AmemError('UNAUTHORIZED', 'login/PAT required');
      const ok = authStore.revokePat(resolved.ctx.userId, req.params.id);
      if (!ok) throw new AmemError('NOT_FOUND', 'token not found');
      storage
        .recordEvent({
          kind: 'auth_token_revoke',
          summary: `Token ${req.params.id} revoked`,
          actor: resolved.ctx.userId,
          meta: { tokenId: req.params.id },
        })
        .catch(() => {});
      return { ok: true };
    });

    fastify.get('/auth/sessions', async (req) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (!resolved?.ctx.userId) throw new AmemError('UNAUTHORIZED', 'login/PAT required');
      const userId = resolved.ctx.userId;
      const oauth = oauthStore.listUserOauthTokens(userId).map((r) => ({
        id: r.id,
        kind: 'oauth',
        type: r.type,
        clientId: r.client_id,
        scopes: JSON.parse(r.scopes || '[]'),
        workspaceIds: JSON.parse(r.workspace_ids || '[]'),
        familyId: r.family_id,
        usedAt: r.used_at,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      }));
      const login = oauthStore.listLoginSessions(userId).map((r) => ({
        id: r.id,
        kind: 'login',
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      }));
      return [...login, ...oauth];
    });

    fastify.delete<{ Params: { id: string } }>('/auth/sessions/:id', async (req) => {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (!resolved?.ctx.userId) throw new AmemError('UNAUTHORIZED', 'login/PAT required');
      const id = req.params.id;
      const ok = id.startsWith('sess_')
        ? oauthStore.revokeLoginSessionById(resolved.ctx.userId, id)
        : oauthStore.revokeOauthTokenById(resolved.ctx.userId, id);
      if (!ok) throw new AmemError('NOT_FOUND', 'session not found');
      storage
        .recordEvent({
          kind: 'auth_session_revoke',
          summary: `Session ${id} revoked`,
          actor: resolved.ctx.userId,
          meta: { sessionId: id },
        })
        .catch(() => {});
      return { ok: true };
    });

    // --- AI providers (LLM endpoints, admin-scoped) ---

    const requireProviderAdmin = (req: object): RequestContext => {
      const ctx = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth?.ctx;
      if (!ctx) throw new AmemError('UNAUTHORIZED', 'admin scope required');
      if (ctx.authEnabled && !hasScope(ctx, 'admin')) {
        throw new AmemError('UNAUTHORIZED', 'admin scope required');
      }
      return ctx;
    };

    fastify.get('/providers', async () => {
      const providers = await storage.listProviders();
      return { providers: providers.map(maskProvider) };
    });

    fastify.post<{ Body: AiProviderInput }>('/providers', async (req) => {
      requireProviderAdmin(req);
      const actor = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth?.ctx.userId ?? 'admin';
      const body = req.body ?? {};
      const name = String(body.name || '').trim();
      const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      const model = String(body.model || '').trim();
      if (!name || !baseUrl || !model) {
        throw new AmemError('VALIDATION', 'name, baseUrl, model required');
      }
      const embeddingModel = body.embeddingModel ? String(body.embeddingModel).trim() : undefined;
      const embeddingBaseUrl = body.embeddingBaseUrl
        ? String(body.embeddingBaseUrl).trim().replace(/\/+$/, '')
        : undefined;
      const embeddingApiKey = body.embeddingApiKey
        ? String(body.embeddingApiKey).trim()
        : undefined;
      const id = body.id ?? `prov_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const provider = await storage.upsertProvider({
        id,
        name,
        kind: 'openai_compatible',
        baseUrl,
        model,
        embeddingModel,
        embeddingBaseUrl,
        embeddingApiKey,
        apiKey: body.apiKey ? String(body.apiKey).trim() : undefined,
        isActive: false,
      });
      storage
        .recordEvent({
          kind: 'provider_create',
          summary: `AI provider "${provider.name}" created`,
          actor,
          meta: { id: provider.id, baseUrl, model },
        })
        .catch(() => {});
      return maskProvider(provider);
    });

    fastify.put<{ Params: { id: string }; Body: Partial<AiProviderInput> }>(
      '/providers/:id',
      async (req) => {
        requireProviderAdmin(req);
        const actor = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth?.ctx.userId ?? 'admin';
        const existing = (await storage.listProviders()).find((p) => p.id === req.params.id);
        if (!existing) throw new AmemError('NOT_FOUND', `Provider not found: ${req.params.id}`);
        const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
        const baseUrl =
          req.body.baseUrl !== undefined
            ? String(req.body.baseUrl).trim().replace(/\/+$/, '')
            : existing.baseUrl;
        const model = req.body.model !== undefined ? String(req.body.model).trim() : existing.model;
        const apiKey =
          req.body.apiKey !== undefined
            ? String(req.body.apiKey).trim() || undefined
            : existing.apiKey;
        const embeddingModel =
          req.body.embeddingModel !== undefined
            ? String(req.body.embeddingModel).trim() || undefined
            : existing.embeddingModel;
        const embeddingBaseUrl =
          req.body.embeddingBaseUrl !== undefined
            ? String(req.body.embeddingBaseUrl).trim().replace(/\/+$/, '') || undefined
            : existing.embeddingBaseUrl;
        const embeddingApiKey =
          req.body.embeddingApiKey !== undefined
            ? String(req.body.embeddingApiKey).trim() || undefined
            : existing.embeddingApiKey;
        if (!name || !baseUrl || !model) {
          throw new AmemError('VALIDATION', 'name, baseUrl, model required');
        }
        const provider = await storage.upsertProvider({
          id: existing.id,
          name,
          kind: existing.kind,
          baseUrl,
          model,
          embeddingModel,
          embeddingBaseUrl,
          embeddingApiKey,
          apiKey,
          isActive: existing.isActive,
        });
        await syncLlmFromProvider();
        await syncEmbedderFromProvider();
        storage
          .recordEvent({
            kind: 'provider_update',
            summary: `AI provider "${provider.name}" updated`,
            actor,
            meta: { id: provider.id },
          })
          .catch(() => {});
        return maskProvider(provider);
      },
    );

    fastify.delete<{ Params: { id: string } }>('/providers/:id', async (req) => {
      requireProviderAdmin(req);
      const actor = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth?.ctx.userId ?? 'admin';
      const existing = (await storage.listProviders()).find((p) => p.id === req.params.id);
      if (!existing) throw new AmemError('NOT_FOUND', `Provider not found: ${req.params.id}`);
      await storage.deleteProvider(req.params.id);
      await syncLlmFromProvider();
      await syncEmbedderFromProvider();
      storage
        .recordEvent({
          kind: 'provider_delete',
          summary: `AI provider "${existing.name}" deleted`,
          actor,
          meta: { id: req.params.id },
        })
        .catch(() => {});
      return { ok: true };
    });

    fastify.post<{ Params: { id: string } }>('/providers/:id/activate', async (req) => {
      requireProviderAdmin(req);
      const actor = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth?.ctx.userId ?? 'admin';
      const existing = (await storage.listProviders()).find((p) => p.id === req.params.id);
      if (!existing) throw new AmemError('NOT_FOUND', `Provider not found: ${req.params.id}`);
      await storage.setActiveProvider(existing.id);
      await syncLlmFromProvider();
      await syncEmbedderFromProvider();
      const active = await storage.getActiveProvider();
      storage
        .recordEvent({
          kind: 'provider_activate',
          summary: `AI provider "${existing.name}" activated`,
          actor,
          meta: { id: existing.id },
        })
        .catch(() => {});
      return { ok: true, active: active ? maskProvider(active) : null };
    });

    fastify.post<{ Params: { id: string } }>('/providers/:id/test', async (req) => {
      requireProviderAdmin(req);
      const actor = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth?.ctx.userId ?? 'admin';
      const existing = (await storage.listProviders()).find((p) => p.id === req.params.id);
      if (!existing) throw new AmemError('NOT_FOUND', `Provider not found: ${req.params.id}`);
      const result = await testProvider(existing);
      storage
        .recordEvent({
          kind: 'provider_test',
          summary: `Tested provider "${existing.name}": ${result.ok ? 'ok' : 'failed'}`,
          actor,
          meta: { id: existing.id, ok: result.ok, latencyMs: result.latencyMs, error: result.error },
        })
        .catch(() => {});
      return result;
    });

    fastify.get('/ai/status', async () => {
      const active = await storage.getActiveProvider();
      const dbOcr = await storage.getOcrSettings();
      const envConfigured = Boolean(config.llm.baseUrl && config.llm.model);
      const activeEmbedding = active?.baseUrl && active.embeddingModel;
      const embeddingModel = activeEmbedding
        ? (active.embeddingModel ?? active.model)
        : config.embedding.mode === 'api'
          ? config.embedding.model
          : undefined;
      return {
        active: active ? maskProvider(active) : null,
        env: envConfigured
          ? {
              baseUrl: config.llm.baseUrl,
              model: config.llm.model,
              hasKey: Boolean(config.llm.apiKey),
            }
          : null,
        mode: active ? 'provider' : envConfigured ? 'env' : 'mock',
        embedding: {
          mode: activeEmbedding ? 'api' : config.embedding.mode,
          model: embeddingModel,
        },
        ocr: config.ocr?.baseUrl && config.ocr.model
          ? { baseUrl: config.ocr.baseUrl, model: config.ocr.model, minChars: config.ocr.minChars }
          : dbOcr
            ? { baseUrl: dbOcr.baseUrl, model: dbOcr.model, minChars: dbOcr.minChars }
            : null,
      };
    });

    // --- OCR settings (vision endpoint for scanned PDFs, admin-scoped) ---

    fastify.get('/ocr/settings', async () => {
      const settings = await storage.getOcrSettings();
      if (!settings) return { settings: null };
      const { apiKey, ...rest } = settings;
      return {
        settings: {
          ...rest,
          hasKey: Boolean(apiKey),
          keyPrefix: apiKey ? `${apiKey.slice(0, 6)}…` : undefined,
        },
      };
    });

    fastify.put<{ Body: OcrSettingsInput }>('/ocr/settings', async (req) => {
      requireProviderAdmin(req);
      const actor = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth?.ctx.userId ?? 'admin';
      const body = req.body ?? {};
      const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      const model = String(body.model || '').trim();
      if (!baseUrl || !model) {
        throw new AmemError('VALIDATION', 'baseUrl and model required');
      }
      const settings = await storage.upsertOcrSettings({
        baseUrl,
        model,
        apiKey: body.apiKey ? String(body.apiKey).trim() : undefined,
        minChars: body.minChars ?? 60,
      });
      storage
        .recordEvent({
          kind: 'ocr_settings_update',
          summary: `OCR endpoint updated: ${settings.model} @ ${settings.baseUrl}`,
          actor,
          meta: { baseUrl: settings.baseUrl, model: settings.model },
        })
        .catch(() => {});
      const { apiKey, ...rest } = settings;
      return {
        settings: {
          ...rest,
          hasKey: Boolean(apiKey),
          keyPrefix: apiKey ? `${apiKey.slice(0, 6)}…` : undefined,
        },
      };
    });

    fastify.delete('/ocr/settings', async (req) => {
      requireProviderAdmin(req);
      const actor = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth?.ctx.userId ?? 'admin';
      await storage.deleteOcrSettings();
      storage
        .recordEvent({
          kind: 'ocr_settings_update',
          summary: 'OCR endpoint cleared',
          actor,
        })
        .catch(() => {});
      return { settings: null };
    });
  };

  // OAuth 2.1 Authorization Server (public client + PKCE)
  app.get('/.well-known/oauth-authorization-server', async (req) => {
    const host = `${req.protocol}://${req.headers.host}`;
    return {
      issuer: host,
      authorization_endpoint: `${host}/oauth/authorize`,
      token_endpoint: `${host}/oauth/token`,
      revocation_endpoint: `${host}/oauth/revoke`,
      registration_endpoint: `${host}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['read', 'write', 'admin'],
      resource: `${host}/mcp`,
    };
  });

  // RFC 9728 Protected Resource Metadata (MCP OAuth discovery)
  const protectedResourceMeta = async (req: { protocol: string; headers: { host?: string } }) => {
    const host = `${req.protocol}://${req.headers.host}`;
    return {
      resource: `${host}/mcp`,
      authorization_servers: [host],
      scopes_supported: ['read', 'write', 'admin'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${host}/`,
    };
  };
  app.get('/.well-known/oauth-protected-resource', protectedResourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMeta);

  // RFC 7591 Dynamic Client Registration (public PKCE clients / Codex)
  app.post('/oauth/register', async (req) => {
    const body = (req.body || {}) as {
      client_name?: string;
      redirect_uris?: string[];
      grant_types?: string[];
      response_types?: string[];
      scope?: string;
    };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!redirectUris.length) {
      throw new AmemError('VALIDATION', 'redirect_uris required');
    }
    const clientId = `dyn_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const name = body.client_name || 'Dynamic MCP Client';
    const scopes = (body.scope || 'read write').split(/\s+/).filter(Boolean);
    authDb
      .prepare(
        `INSERT INTO oauth_clients
         (client_id, client_name, client_secret_hash, redirect_uris, grants, scopes, public, owner_user_id, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, 1, NULL, ?, ?)`,
      )
      .run(
        clientId,
        name,
        JSON.stringify(redirectUris),
        JSON.stringify(body.grant_types || ['authorization_code', 'refresh_token']),
        JSON.stringify(scopes),
        now,
        now,
      );
    return {
      client_id: clientId,
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: body.grant_types || ['authorization_code', 'refresh_token'],
      response_types: body.response_types || ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
  });

  app.get('/oauth/authorize', async (req, reply) => {
    oauthStore.ensureWebClient();
    const q = req.query as Record<string, string>;
    const clientId = q.client_id || 'amem-web';
    const redirectUri = q.redirect_uri || '';
    const state = q.state || '';
    const scope = q.scope || 'read write';
    const challenge = q.code_challenge || '';
    const method = q.code_challenge_method || 'S256';
    const client = oauthStore.getOauthClient(clientId);
    if (!client)
      return reply
        .code(400)
        .type('text/html')
        .send(authHtmlPage('Error', '<h1>Unknown client</h1>'));
    try {
      requireRedirectAllowed(client.redirect_uris, redirectUri, {
        allowLoopback: Boolean(client.public),
      });
    } catch (e) {
      return reply
        .code(400)
        .type('text/html')
        .send(
          authHtmlPage(
            'Error',
            `<h1>Invalid redirect</h1><p class="err">${(e as Error).message}</p>`,
          ),
        );
    }
    if (!challenge) {
      return reply
        .code(400)
        .type('text/html')
        .send(
          authHtmlPage(
            'Error',
            '<h1>PKCE required</h1><p class="muted">code_challenge is mandatory (S256).</p>',
          ),
        );
    }

    // If session cookie present and valid, skip login form.
    const cookies = String(req.headers.cookie || '');
    const m = cookies.match(/(?:^|;\s*)amem_session=([^;]+)/);
    if (m) {
      const sess = oauthStore.findLoginSession(hashToken(authSecret, decodeURIComponent(m[1]!)));
      if (sess) {
        // Show consent page — user must explicitly approve scopes
        const scopeList = scope.split(/[\s+]+/).filter(Boolean);
        const scopeDescs: Record<string, string> = {
          read: 'Read your knowledge graph units and search history',
          write: 'Create, update, and delete knowledge units on your behalf',
          admin: 'Manage workspaces, members, and API tokens',
          'ws:personal:read': 'Read knowledge in your Personal workspace',
          'ws:personal:write': 'Write knowledge in your Personal workspace',
        };
        const scopeItems = scopeList
          .map((s) => `<li><b>${s}</b> — ${scopeDescs[s] || 'Access this scope'}</li>`)
          .join('');
        const consentBody = `
         <h1>Authorize ${client.client_name}</h1>
         <p class="muted">${client.client_name} is requesting the following permissions:</p>
         <ul style="text-align:left;padding:0 0 0 20px;margin:12px 0">${scopeItems}</ul>
         <form method="POST" action="/oauth/consent">
           <input type="hidden" name="client_id" value="${clientId}"/>
           <input type="hidden" name="redirect_uri" value="${redirectUri.replace(/"/g, '&quot;')}"/>
           <input type="hidden" name="state" value="${state.replace(/"/g, '&quot;')}"/>
           <input type="hidden" name="scope" value="${scope.replace(/"/g, '&quot;')}"/>
           <input type="hidden" name="code_challenge" value="${challenge.replace(/"/g, '&quot;')}"/>
           <input type="hidden" name="code_challenge_method" value="${method}"/>
           <button type="submit" style="background:#3fb97f;border-color:#3fb97f">Approve</button>
         </form>
         <form method="GET" action="/oauth/deny" style="margin-top:8px">
           <input type="hidden" name="redirect_uri" value="${redirectUri.replace(/"/g, '&quot;')}"/>
           <input type="hidden" name="state" value="${state.replace(/"/g, '&quot;')}"/>
           <button type="submit" style="background:transparent;border:1px solid #ef5350;color:#ef5350">Deny</button>
         </form>`;
        return reply.type('text/html').send(authHtmlPage('Authorize', consentBody));
      }
    }

    const body = `
      <h1>Sign in to Amem</h1>
      <p class="muted">Authorize <b>${client.client_name}</b> for scopes: <code>${scope}</code></p>
      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="client_id" value="${clientId}"/>
        <input type="hidden" name="redirect_uri" value="${redirectUri.replace(/"/g, '&quot;')}"/>
        <input type="hidden" name="state" value="${state.replace(/"/g, '&quot;')}"/>
        <input type="hidden" name="scope" value="${scope.replace(/"/g, '&quot;')}"/>
        <input type="hidden" name="code_challenge" value="${challenge.replace(/"/g, '&quot;')}"/>
        <input type="hidden" name="code_challenge_method" value="${method}"/>
        <label>Email</label><input name="email" type="email" required/>
        <label>Password</label><input name="password" type="password" required/>
        <button type="submit">Authorize</button>
      </form>`;
    return reply.type('text/html').send(authHtmlPage('Authorize', body));
  });

  app.post('/oauth/authorize', async (req, reply) => {
    // parse urlencoded or json
    let body: Record<string, string> = {};
    if (typeof req.body === 'string') {
      body = Object.fromEntries(new URLSearchParams(req.body));
    } else if (req.body && typeof req.body === 'object') {
      body = req.body as Record<string, string>;
    }
    const email = String(body.email || '');
    const password = String(body.password || '');
    const clientId = String(body.client_id || 'amem-web');
    const redirectUri = String(body.redirect_uri || '');
    const state = String(body.state || '');
    const scope = String(body.scope || 'read write');
    const challenge = String(body.code_challenge || '');
    const method = String(body.code_challenge_method || 'S256');
    const user = authStore.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      storage
        .recordEvent({
          kind: 'auth_login_failed',
          summary: `Failed OAuth login attempt for ${email}`,
          actor: email,
          meta: { clientId },
        })
        .catch(() => {});
      return reply
        .code(401)
        .type('text/html')
        .send(
          authHtmlPage(
            'Authorize',
            '<h1>Sign in failed</h1><p class="err">Invalid email or password.</p>',
          ),
        );
    }
    const client = oauthStore.getOauthClient(clientId);
    if (!client) return reply.code(400).send('unknown client');
    requireRedirectAllowed(client.redirect_uris, redirectUri, {
      allowLoopback: Boolean(client.public),
    });

    // set session cookie
    const sessionToken = newOpaqueToken('amem_sess_');
    oauthStore.createLoginSession(user.id, hashToken(authSecret, sessionToken));
    reply.header(
      'set-cookie',
      `amem_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}${config.cookieSecure ? '; Secure' : ''}`,
    );

    // Redirect back to GET /oauth/authorize — session cookie will trigger consent page
    const consentUrl = `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=${encodeURIComponent(method)}`;
    return reply.redirect(consentUrl);
  });

  // OAuth consent — user explicitly approved scopes
  app.post('/oauth/consent', async (req, reply) => {
    let body: Record<string, string> = {};
    if (typeof req.body === 'string') body = Object.fromEntries(new URLSearchParams(req.body));
    else if (req.body && typeof req.body === 'object') body = req.body as Record<string, string>;
    const cookies = String(req.headers.cookie || '');
    const m = cookies.match(/(?:^|;\s*)amem_session=([^;]+)/);
    if (!m)
      return reply
        .code(401)
        .type('text/html')
        .send(
          authHtmlPage(
            'Error',
            '<h1>Session expired</h1><p class="muted">Please restart authorization.</p>',
          ),
        );
    const sess = oauthStore.findLoginSession(hashToken(authSecret, decodeURIComponent(m[1]!)));
    if (!sess)
      return reply
        .code(401)
        .type('text/html')
        .send(
          authHtmlPage(
            'Error',
            '<h1>Session expired</h1><p class="muted">Please restart authorization.</p>',
          ),
        );
    const clientId = String(body.client_id || 'amem-web');
    const redirectUri = String(body.redirect_uri || '');
    const state = String(body.state || '');
    const scope = String(body.scope || 'read write');
    const challenge = String(body.code_challenge || '');
    const method = String(body.code_challenge_method || 'S256');
    const client = oauthStore.getOauthClient(clientId);
    if (!client) return reply.code(400).send('unknown client');
    requireRedirectAllowed(client.redirect_uris, redirectUri, {
      allowLoopback: Boolean(client.public),
    });
    const code = newOpaqueToken('amem_code_');
    const userWorkspaces = authStore.listWorkspacesForUser(sess.user_id).map((w) => w.id);
    oauthStore.saveOauthCode({
      codeHash: hashToken(authSecret, code),
      clientId,
      userId: sess.user_id,
      scopes: scope.split(/[\s+]+/).filter(Boolean),
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: method,
      workspaceIds: userWorkspaces,
      expiresAt: new Date(Date.now() + 5 * 60e3).toISOString(),
    });
    storage
      .recordEvent({
        kind: 'auth_login',
        summary: `OAuth consent granted for ${client.client_name}`,
        actor: sess.user_id,
        meta: { clientId, scopes: scope },
      })
      .catch(() => {});
    const u = new URL(redirectUri);
    u.searchParams.set('code', code);
    if (state) u.searchParams.set('state', state);
    return reply.redirect(u.toString());
  });

  // OAuth deny — user refused consent
  app.get('/oauth/deny', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const redirectUri = q.redirect_uri || '';
    const state = q.state || '';
    const u = new URL(redirectUri);
    u.searchParams.set('error', 'access_denied');
    u.searchParams.set('error_description', 'User denied authorization');
    if (state) u.searchParams.set('state', state);
    return reply.redirect(u.toString());
  });

  app.post('/oauth/token', async (req, _reply) => {
    let body: Record<string, string> = {};
    if (typeof req.body === 'string') body = Object.fromEntries(new URLSearchParams(req.body));
    else if (req.body && typeof req.body === 'object') body = req.body as Record<string, string>;

    const grant = body.grant_type;
    if (grant === 'authorization_code') {
      const code = body.code || '';
      const redirectUri = body.redirect_uri || '';
      const clientId = body.client_id || 'amem-web';
      const verifier = body.code_verifier || '';
      const row = oauthStore.consumeOauthCode(hashToken(authSecret, code));
      if (!row) throw new AmemError('UNAUTHORIZED', 'Invalid authorization code');
      if (row.client_id !== clientId) throw new AmemError('UNAUTHORIZED', 'client_id mismatch');
      if (row.redirect_uri !== redirectUri)
        throw new AmemError('UNAUTHORIZED', 'redirect_uri mismatch');
      if (!verifyPkce(verifier, row.code_challenge, row.code_challenge_method)) {
        throw new AmemError('UNAUTHORIZED', 'PKCE verification failed');
      }
      const scopes = JSON.parse(row.scopes || '[]') as string[];
      const workspaceIds = JSON.parse(row.workspace_ids || '[]') as string[];
      return issueTokenPair(oauthStore, authSecret, {
        userId: row.user_id,
        clientId,
        scopes,
        workspaceIds,
      });
    }

    if (grant === 'refresh_token') {
      const refresh = body.refresh_token || '';
      const tokenHash = hashToken(authSecret, refresh);
      const row = oauthStore.findOauthToken(tokenHash, 'refresh');
      if (!row) {
        // Rotated refresh token presented again => likely theft. Burn the family.
        const maybe = oauthStore.findOauthTokenIncludingRevoked(tokenHash, 'refresh');
        if (maybe) {
          oauthStore.revokeOauthFamily(maybe.family_id);
          storage
            .recordEvent({
              kind: 'oauth_refresh_reuse',
              summary: `Refresh token reuse detected for family ${maybe.family_id.slice(0, 8)}; family revoked`,
              actor: maybe.user_id,
              meta: { familyId: maybe.family_id, clientId: maybe.client_id },
            })
            .catch(() => {});
          throw new AmemError(
            'UNAUTHORIZED',
            'Refresh token reused; all sessions for this grant revoked',
          );
        }
        throw new AmemError('UNAUTHORIZED', 'Invalid refresh token');
      }
      // rotate: revoke family, mark old refresh as used, then issue new pair
      oauthStore.revokeOauthFamily(row.family_id);
      oauthStore.touchOauthToken(row.id);
      return issueTokenPair(oauthStore, authSecret, {
        userId: row.user_id,
        clientId: row.client_id,
        scopes: JSON.parse(row.scopes || '[]') as string[],
        workspaceIds: JSON.parse(row.workspace_ids || '[]') as string[],
        familyId: row.family_id,
      });
    }

    throw new AmemError('VALIDATION', `Unsupported grant_type: ${grant}`);
  });

  app.post('/oauth/revoke', async (req) => {
    let body: Record<string, string> = {};
    if (typeof req.body === 'string') body = Object.fromEntries(new URLSearchParams(req.body));
    else if (req.body && typeof req.body === 'object') body = req.body as Record<string, string>;
    const token = body.token || '';
    if (token) oauthStore.revokeOauthTokenHash(hashToken(authSecret, token));
    return null;
  });

  await app.register(api, { prefix: '/api/v1' });

  // Convenience alias (Docker / probes / humans). Canonical JSON health is /api/v1/health.
  app.get('/health', async (_req, reply) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    reply.code(res.statusCode).headers(res.headers).send(res.json());
  });

  // Streamable HTTP MCP with proper Accept + session negotiation.
  const isInitializeBody = (body: unknown): boolean => {
    const msgs = Array.isArray(body) ? body : body ? [body] : [];
    return msgs.some(
      (m) => m && typeof m === 'object' && (m as { method?: string }).method === 'initialize',
    );
  };

  app.all('/mcp', async (req, reply) => {
    // HTTP MCP is OAuth-first (MCP OAuth / RFC 9728). Bearer PAT also accepted.
    // Set AMEM_MCP_OAUTH=0 only for fully open local demos.
    const host = `${req.protocol}://${req.headers.host}`;
    const oauthMode = process.env.AMEM_MCP_OAUTH;
    const wantAuth = oauthMode === '0' ? false : true;
    if (wantAuth) {
      const resolved = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth;
      if (!resolved || resolved.ctx.realm === 'anonymous') {
        reply.header(
          'WWW-Authenticate',
          `Bearer realm="amem", resource_metadata="${host}/.well-known/oauth-protected-resource/mcp"`,
        );
        return reply.code(401).send({
          error: 'invalid_token',
          error_description: 'Authentication required. Use OAuth (PKCE) or Bearer PAT.',
        });
      }
    }

    reply.hijack();
    let ephemeral: McpSession | undefined;
    try {
      const sessionHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
      const rawBody =
        req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
          ? typeof req.body === 'string'
            ? req.body
            : req.body === undefined
              ? undefined
              : JSON.stringify(req.body)
          : undefined;
      const parsed = rawBody ? (JSON.parse(rawBody) as unknown) : undefined;

      let session: McpSession | undefined = sessionId ? mcpSessions.get(sessionId) : undefined;

      if (!session) {
        if (req.method === 'POST' && isInitializeBody(parsed)) {
          const mcp = await openMcpSession();
          let bound: McpSession | undefined;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: async (sid: string) => {
              bound = { transport, mcp };
              mcpSessions.set(sid, bound);
            },
          });
          await mcp.server.connect(transport);
          session = bound ?? { transport, mcp };
        } else if (!sessionId) {
          // Stateless one-shot transport for simple clients.
          const mcp = await openMcpSession();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          await mcp.server.connect(transport);
          ephemeral = { transport, mcp };
          session = ephemeral;
        } else {
          reply.raw.statusCode = 404;
          reply.raw.setHeader('content-type', 'application/json');
          reply.raw.end(JSON.stringify({ error: 'Unknown MCP session' }));
          return;
        }
      }

      // Ensure required Accept header if client omitted it (compat shim).
      if (!req.headers.accept || !String(req.headers.accept).includes('text/event-stream')) {
        req.headers.accept = 'application/json, text/event-stream';
      } else if (!String(req.headers.accept).includes('application/json')) {
        req.headers.accept = `${req.headers.accept}, application/json`;
      }

      // Bind the request's own auth/zone context (resolved in onRequest) for
      // the whole MCP dispatch. ALS `enterWith` is Node-version dependent and
      // can leak a *previous* request's context into the tool handlers, so we
      // use an explicit `run` scope instead of relying on the ambient store.
      const requestCtx = (req as { amemAuth?: { ctx: RequestContext } }).amemAuth?.ctx;
      if (requestCtx) {
        await runWithRequestContextAsync(requestCtx, () =>
          session.transport.handleRequest(req.raw, reply.raw, parsed),
        );
      } else {
        await session.transport.handleRequest(req.raw, reply.raw, parsed);
      }
    } catch (err) {
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(
          JSON.stringify({ error: err instanceof Error ? err.message : 'MCP handler failed' }),
        );
      }
    } finally {
      if (ephemeral) {
        try {
          await ephemeral.transport.close();
        } catch {
          /* ignore */
        }
        try {
          await ephemeral.mcp.close();
        } catch {
          /* ignore */
        }
      }
    }
  });

  // Scheduler: debounced background consolidation.
  let timer: NodeJS.Timeout | undefined;
  let runsThisHour = 0;
  let hourWindow = Date.now();
  const startScheduler = () => {
    if (!config.jobs.enabled) return;
    timer = setInterval(async () => {
      const now = Date.now();
      if (now - hourWindow >= 3_600_000) {
        hourWindow = now;
        runsThisHour = 0;
      }
      if (runsThisHour >= config.jobs.maxPerHour) return;
      runsThisHour++;
      try {
        // Alternate lightweight consolidation with full asset precipitation
        // (scenarios/persona/skills + codegraph + wiki).
        if (runsThisHour % 3 === 0) {
          await service.autoPrecipitate({ mode: 'auto' });
        } else {
          await service.curate('fast');
        }
      } catch {
        /* scheduler must never crash the server */
      }
    }, config.jobs.intervalMs);
    timer.unref?.();
  };
  startScheduler();

  // Serve built web UI if present (ESM-safe resolution).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.AMEM_WEB_DIR,
    path.resolve(here, '../../../apps/web/dist'),
    path.resolve(here, '../../apps/web/dist'),
    path.resolve(process.cwd(), 'apps/web/dist'),
  ].filter((c): c is string => Boolean(c));
  const webDir = candidates.find((c) => existsSync(path.join(c, 'index.html')));
  if (webDir) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      const pathOnly = (req.url || '').split('?')[0] || '';
      if (
        req.method !== 'GET' ||
        pathOnly.startsWith('/api/') ||
        pathOnly.startsWith('/mcp') ||
        pathOnly.startsWith('/oauth/') ||
        pathOnly.startsWith('/.well-known/') ||
        pathOnly === '/health'
      ) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      }
      return reply.sendFile('index.html');
    });
  }

  const close = async () => {
    if (timer) clearInterval(timer);
    try {
      await app.close();
    } finally {
      for (const s of mcpSessions.values()) {
        try {
          await s.transport.close();
        } catch {
          /* ignore */
        }
        try {
          await s.mcp.close();
        } catch {
          /* ignore */
        }
      }
      mcpSessions.clear();
      try {
        authDb.close();
      } catch {
        /* ignore */
      }
      await storage.close();
    }
  };

  if (opts?.listen) {
    await app.listen({ port: config.port, host: config.host });
    const addr = app.server.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : config.port;
    return { app, url: `http://${config.host}:${actualPort}`, close, rateLimiter };
  }
  return { app, close, rateLimiter };
}

// small helper to keep logs typed-loose
function reqLog(app: FastifyInstance) {
  return {
    error: (obj: object, msg: string) =>
      (app.log as { error?: (o: object, m: string) => void }).error?.(obj, msg),
  };
}

export type { AmemErrorType };
