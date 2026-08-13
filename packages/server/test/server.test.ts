import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AmemConfig } from '@amem/core';
import { createServer, type ServerHandle } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

function testConfig(overrides: Partial<AmemConfig> = {}): AmemConfig {
  const dir = mkdtempSync(join(tmpdir(), 'amem-srv-'));
  return {
    dbPath: join(dir, 'test.db'),
    host: '127.0.0.1',
    port: 0,
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
    ...overrides,
  };
}

describe('Amem REST API', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await createServer(testConfig());
    app = handle.app;
    await app.ready();
  });
  afterAll(async () => {
    await handle.close();
  });

  async function j(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    let data: unknown = null;
    try { data = res.json(); } catch { data = res.body; }
    return { status: res.statusCode, body: data };
  }

  it('GET /api/v1/health', async () => {
    const { status, body } = await j('GET', '/api/v1/health');
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  it('POST /ingest accepts a brand-new sessionId (FK ordering)', async () => {
    const { status, body } = await j('POST', '/api/v1/ingest', {
      sessionId: 'sess-new-' + Date.now(),
      title: 'Session-scoped note',
      content: 'Alice lives in Paris and likes jazz music. Bob prefers the S&P 500.',
    });
    expect(status).toBe(200);
    const b = body as { units: unknown[] };
    expect(Array.isArray(b.units)).toBe(true);
    expect(b.units.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /ingest extracts units', async () => {
    const { status, body } = await j('POST', '/api/v1/ingest', {
      title: 'Decision: use SQLite for Amem',
      content:
        'We decided to store agent memory in a local SQLite file. ' +
        'Procedure: embed each unit and dedup before insert. ' +
        'Preference: data stays on our disk for sovereignty.',
    });
    expect(status).toBe(200);
    const b = body as { units: unknown[] };
    expect(Array.isArray(b.units)).toBe(true);
    expect(b.units.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /recall returns a context block', async () => {
    const { status, body } = await j('POST', '/api/v1/recall', {
      query: 'how should agent memory be stored',
      tokenBudget: 2000,
    });
    expect(status).toBe(200);
    const b = body as { items: unknown[]; text: string; usedTokens: number };
    expect(b.items.length).toBeGreaterThanOrEqual(1);
    expect(b.text.length).toBeGreaterThan(0);
    expect(b.usedTokens).toBeLessThanOrEqual(2000);
  });

  it('GET /search', async () => {
    const { status } = await j('GET', '/api/v1/search?q=memory');
    expect(status).toBe(200);
  });

  it('GET /stats', async () => {
    const { status, body } = await j('GET', '/api/v1/stats');
    expect(status).toBe(200);
    const s = body as { counts: { units: number; scenarios: number; assets: number }; byCategory: Record<string, number> };
    expect(s.counts.units).toBeGreaterThanOrEqual(1);
    expect(typeof s.counts.scenarios).toBe('number');
    expect(typeof s.counts.assets).toBe('number');
    expect(typeof s.byCategory).toBe('object');
  });

  it('GET /units and GET /units/:id + 404', async () => {
    const list = (await j('GET', '/api/v1/units')).body as Array<{ id: string }>;
    expect(Array.isArray(list)).toBe(true);
    if (list.length) {
      const one = await j('GET', `/api/v1/units/${list[0].id}`);
      expect(one.status).toBe(200);
    }
    const missing = await j('GET', '/api/v1/units/does-not-exist');
    expect(missing.status).toBe(404);
  });

  it('GET /export/okf returns a bundle', async () => {
    const { status, body } = await j('GET', '/api/v1/export/okf');
    expect(status).toBe(200);
    const files = (body as { files: Record<string, string> }).files;
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(files['index.md']).toBeDefined();
  });

  it('GET /api/v1/activity shows writes and recalls', async () => {
    await j('POST', '/api/v1/ingest', {
      title: 'Activity seed',
      content: 'Decision: Amem is the Codex memory layer. Procedure: call recall at session start.',
    });
    await j('POST', '/api/v1/recall', { query: 'Codex memory layer', topK: 5 });
    const { status, body } = await j('GET', '/api/v1/activity?limit=20');
    expect(status).toBe(200);
    const events = body as Array<{ kind: string; summary: string }>;
    expect(Array.isArray(events)).toBe(true);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('ingest');
    expect(kinds).toContain('recall');
  });

  it('GET /api/v1/activity/summary aggregates input/output flow and accessed memory regions', async () => {
    await j('POST', '/api/v1/ingest', {
      title: 'Flow summary seed',
      content: 'Decision: data flow panels should read from the summary endpoint. Procedure: ingest then recall.',
    });
    await j('POST', '/api/v1/recall', { query: 'data flow panels', topK: 8 });
    const { status, body } = await j('GET', '/api/v1/activity/summary?hours=24');
    expect(status).toBe(200);
    const s = body as {
      window: { events: number; hours: number };
      input: { total: number; byKind: Record<string, number>; unitsCreated: number };
      output: { total: number; byKind: Record<string, number>; tokensDelivered: number; budgetUsed: number; tokenSavings: number };
      accessedUnits: Array<{ unitId: string; title: string; type: string; category: string; tags: string[]; accessCount: number; actors: string[] }>;
      regions: { byType: Array<{ key: string; count: number }>; byCategory: Array<{ key: string; count: number }>; byTag: Array<{ key: string; count: number }> };
      topActors: Array<{ actor: string; writes: number; reads: number }>;
    };
    expect(s.window.hours).toBe(24);
    expect(s.window.events).toBeGreaterThanOrEqual(3);
    expect(s.input.byKind.ingest).toBeGreaterThanOrEqual(1);
    expect(s.input.unitsCreated).toBeGreaterThanOrEqual(1);
    expect(s.output.byKind.recall).toBeGreaterThanOrEqual(1);
    expect(s.output.tokensDelivered).toBeGreaterThan(0);
    expect(s.output.budgetUsed).toBeGreaterThanOrEqual(s.output.tokensDelivered);
    expect(s.accessedUnits.length).toBeGreaterThanOrEqual(1);
    const hit = s.accessedUnits.find((u) => u.accessCount >= 1 && u.type && u.title);
    expect(hit).toBeDefined();
    expect(s.regions.byType.length).toBeGreaterThanOrEqual(1);
    expect(s.regions.byCategory.length).toBeGreaterThanOrEqual(1);
    expect(s.topActors.length).toBeGreaterThanOrEqual(1);
    const amem = s.topActors.find((a) => a.actor === 'amem');
    expect(amem?.writes).toBeGreaterThanOrEqual(1);
    expect(amem?.reads).toBeGreaterThanOrEqual(1);
  });

  it('POST /assets/extract/codegraph and /assets/extract/wiki are idempotent', async () => {
    await j('POST', '/api/v1/import/codebase', {
      path: fileURLToPath(new URL('..', import.meta.url)),
      maxFiles: 3,
    });
    const first = (await j('POST', '/api/v1/assets/extract/codegraph', {})).body as {
      created: number;
      updated: number;
    };
    expect(first.created).toBeGreaterThanOrEqual(1);
    const second = (await j('POST', '/api/v1/assets/extract/codegraph', {})).body as {
      created: number;
      updated: number;
    };
    expect(second.created).toBe(0);
    expect(second.updated).toBeGreaterThanOrEqual(1);

    const wiki = (await j('POST', '/api/v1/assets/extract/wiki', {})).body as {
      created: number;
      updated: number;
    };
    expect(typeof wiki.created).toBe('number');
    expect(typeof wiki.updated).toBe('number');
  });

  it('GET /assets/:id/versions returns the skill version chain', async () => {
    // Seed a procedure unit and run heuristic skill extraction.
    const ingest = await j('POST', '/api/v1/units', {
      unit: {
        type: 'procedure',
        form: 'unit',
        title: 'Rotate DB credentials',
        body: '1. stop container\n2. rotate secret',
        summary: 'Credential rotation',
        tags: ['ops'],
        status: 'reviewed',
      },
    });
    expect(ingest.status).toBe(200);
    const first = await j('POST', '/api/v1/skills/extract', { includePending: true });
    expect(first.status).toBe(200);
    const assets = (await j('GET', '/api/v1/assets?kind=skill')).body as Array<{
      id: string;
      version: number;
      body: string;
    }>;
    expect(assets.length).toBeGreaterThanOrEqual(1);
    const asset = assets[0]!;
    expect(asset.version).toBe(1);
    expect((await j('GET', `/api/v1/assets/${asset.id}/versions`)).body).toEqual([]);

    // Content change -> new version + snapshot of v1.
    await j('PATCH', `/api/v1/units/${encodeURIComponent((ingest.body as { id: string }).id)}`, {
      patch: { body: '1. stop container\n2. rotate secret\n3. verify new secret works' },
      reason: 'test: rotate gained a verification step',
    });
    const second = await j('POST', '/api/v1/skills/extract', { includePending: true });
    expect((second.body as { updated: number }).updated).toBeGreaterThan(0);
    const current = (await j('GET', '/api/v1/assets?kind=skill')).body as Array<{
      id: string;
      version: number;
      body: string;
    }>;
    const updatedAsset = current.find((a) => a.id === asset.id)!;
    expect(updatedAsset.version).toBe(2);
    const versions = (await j('GET', `/api/v1/assets/${asset.id}/versions`)).body as Array<{
      version: number;
      reason: string;
      snapshot: { body: string };
    }>;
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.snapshot.body).toContain('rotate secret');
    expect(versions[0]!.snapshot.body).not.toContain('verify new secret');

    // No-op patch (same content) does not fork the chain or bump the version.
    const noop = await j('PATCH', `/api/v1/assets/${asset.id}`, {
      patch: { body: updatedAsset.body },
      reason: 'no-op',
    });
    expect((noop.body as { version: number }).version).toBe(2);
    expect(((await j('GET', `/api/v1/assets/${asset.id}/versions`)).body as unknown[]).length).toBe(1);

    // Pure metadata patch (status) keeps the version number stable.
    const meta = await j('PATCH', `/api/v1/assets/${asset.id}`, {
      patch: { status: 'published' },
      reason: 'review: publish',
    });
    expect((meta.body as { version: number; status: string }).version).toBe(2);
    expect((meta.body as { version: number; status: string }).status).toBe('published');
    expect(((await j('GET', `/api/v1/assets/${asset.id}/versions`)).body as unknown[]).length).toBe(1);

    // Deleting an asset with version history succeeds and clears the chain.
    const del = await j('DELETE', `/api/v1/assets/${asset.id}`);
    expect(del.status).toBe(200);
    expect((await j('GET', `/api/v1/assets/${asset.id}/versions`)).status).toBe(404);
  });

  it('POST /assets/route ranks published assets for a task', async () => {
    const ingest = await j('POST', '/api/v1/units', {
      unit: {
        type: 'procedure',
        form: 'unit',
        title: 'Rotate DB credentials',
        body: '1. stop container\n2. rotate secret\n3. restart',
        summary: 'Credential rotation',
        tags: ['ops'],
        status: 'reviewed',
      },
    });
    expect(ingest.status).toBe(200);
    await j('POST', '/api/v1/skills/extract', { includePending: true });

    const assets = (await j('GET', '/api/v1/assets?kind=skill')).body as Array<{
      id: string;
      name: string;
      status: string;
    }>;
    const skill = assets.find((a) => /credential/i.test(a.name)) ?? assets[0];
    expect(skill).toBeDefined();
    await j('PATCH', `/api/v1/assets/${skill!.id}`, {
      patch: { status: 'published' },
      reason: 'test: publish for routing',
    });

    const routed = await j('POST', '/api/v1/assets/route', {
      task: 'rotate database credentials before release',
      limit: 5,
    });
    expect(routed.status).toBe(200);
    const body = routed.body as {
      query: string;
      items: Array<{ asset: { id: string; name: string }; score: number; reason: string }>;
      usedTokens: number;
    };
    expect(body.query).toContain('rotate');
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]!.asset.id).toBe(skill!.id);
    expect(body.usedTokens).toBeGreaterThan(0);
  });

  it('POST /assets/route rejects a missing task', async () => {
    const res = await j('POST', '/api/v1/assets/route', {});
    expect(res.status).toBe(400);
  });

  it('POST /layers/precipitate runs the full pipeline', async () => {
    const { status, body } = await j('POST', '/api/v1/layers/precipitate', { mode: 'fast' });
    expect(status).toBe(200);
    const b = body as {
      mode: string;
      skillsExtracted: number;
      codegraphCreated: number;
      wikiCreated: number;
    };
    expect(b.mode).toBe('fast');
    expect(typeof b.skillsExtracted).toBe('number');
    expect(typeof b.codegraphCreated).toBe('number');
    expect(typeof b.wikiCreated).toBe('number');
  });
});

describe('Amem REST API · activity summary on a fresh store', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await createServer(testConfig());
    app = handle.app;
    await app.ready();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('GET /api/v1/activity/summary returns zeroed aggregates when there are no events', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/activity/summary' });
    expect(res.statusCode).toBe(200);
    const s = res.json() as {
      window: { events: number };
      input: { total: number };
      output: { total: number; tokensDelivered: number; budgetUsed: number; tokenSavings: number };
      accessedUnits: unknown[];
      regions: { byType: unknown[]; byCategory: unknown[]; byTag: unknown[] };
      topActors: unknown[];
    };
    expect(s.window.events).toBe(0);
    expect(s.input.total).toBe(0);
    expect(s.output.total).toBe(0);
    expect(s.output.tokensDelivered).toBe(0);
    expect(s.output.budgetUsed).toBe(0);
    expect(s.output.tokenSavings).toBe(0);
    expect(s.accessedUnits).toEqual([]);
    expect(s.regions.byType).toEqual([]);
    expect(s.regions.byCategory).toEqual([]);
    expect(s.regions.byTag).toEqual([]);
    expect(s.topActors).toEqual([]);
  });
});

describe('AI provider API', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await createServer(testConfig());
    app = handle.app;
    await app.ready();
  });
  afterAll(async () => {
    await handle.close();
  });

  async function j(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    let data: unknown = null;
    try { data = res.json(); } catch { data = res.body; }
    return { status: res.statusCode, body: data as Record<string, unknown> };
  }

  it('reports mock mode when no provider or env LLM is configured', async () => {
    const { status, body } = await j('GET', '/api/v1/ai/status');
    expect(status).toBe(200);
    expect(body.mode).toBe('mock');
    expect(body.active).toBeNull();
  });

  it('CRUD, key masking, activation, and deletion roundtrip', async () => {
    const created = await j('POST', '/api/v1/providers', {
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1/',
      model: 'deepseek-chat',
      apiKey: 'sk-secret-abcdef123456',
    });
    expect(created.status).toBe(200);
    expect(created.body).not.toHaveProperty('apiKey');
    expect((created.body as { hasKey?: boolean }).hasKey).toBe(true);
    expect((created.body as { keyPrefix?: string }).keyPrefix).toBe('sk-sec…');
    const id = (created.body as { id?: string }).id!;

    try {
      const list = await j('GET', '/api/v1/providers');
      expect(list.status).toBe(200);
      const rows = (list.body as { providers: Array<{ id: string; model: string }> }).providers;
      expect(rows.some((p) => p.id === id)).toBe(true);

      const statusBefore = await j('GET', '/api/v1/ai/status');
      expect(statusBefore.body.mode).toBe('mock');

      const act = await j('POST', `/api/v1/providers/${id}/activate`);
      expect(act.status).toBe(200);
      expect((act.body as { ok?: boolean }).ok).toBe(true);

      const statusAfter = await j('GET', '/api/v1/ai/status');
      expect(statusAfter.body.mode).toBe('provider');
      expect((statusAfter.body.active as { id?: string }).id).toBe(id);

      const updated = await j('PUT', `/api/v1/providers/${id}`, { model: 'deepseek-reasoner' });
      expect(updated.status).toBe(200);
      expect((updated.body as { model?: string }).model).toBe('deepseek-reasoner');
      expect((updated.body as { hasKey?: boolean }).hasKey).toBe(true);
      expect(updated.body).not.toHaveProperty('apiKey');
    } finally {
      const del = await j('DELETE', `/api/v1/providers/${id}`);
      expect(del.status).toBe(200);
      expect((del.body as { ok?: boolean }).ok).toBe(true);
    }

    const after = await j('GET', '/api/v1/providers');
    const rows = (after.body as { providers: Array<{ id: string }> }).providers;
    expect(rows.some((p) => p.id === id)).toBe(false);
  });

  it('supports a separate embedding model surfaced in ai/status', async () => {
    const created = await j('POST', '/api/v1/providers', {
      name: 'Embed Provider',
      baseUrl: 'https://api.example.com/v1/',
      model: 'chat-model',
      embeddingModel: 'text-embedding-v3',
    });
    expect(created.status).toBe(200);
    expect((created.body as { embeddingModel?: string }).embeddingModel).toBe('text-embedding-v3');
    const id = (created.body as { id?: string }).id!;
    try {
      const before = await j('GET', '/api/v1/ai/status');
      expect((before.body.embedding as { mode?: string }).mode).toBe('offline');

      const act = await j('POST', `/api/v1/providers/${id}/activate`);
      expect(act.status).toBe(200);

      const after = await j('GET', '/api/v1/ai/status');
      expect(after.status).toBe(200);
      expect((after.body.embedding as { mode?: string }).mode).toBe('api');
      expect((after.body.embedding as { model?: string }).model).toBe('text-embedding-v3');

      const updated = await j('PUT', `/api/v1/providers/${id}`, { embeddingModel: '' });
      expect(updated.status).toBe(200);
      expect((updated.body as { embeddingModel?: string }).embeddingModel).toBeUndefined();

      const afterUpdate = await j('GET', '/api/v1/ai/status');
      expect((afterUpdate.body.embedding as { mode?: string }).mode).toBe('offline');
    } finally {
      await j('DELETE', `/api/v1/providers/${id}`);
    }
  });

  it('supports a separate embedding endpoint (baseUrl + key) without leaking the key', async () => {
    const created = await j('POST', '/api/v1/providers', {
      name: 'Chat + Embed Provider',
      baseUrl: 'https://chat.example.com/v1',
      model: 'chat-model',
      embeddingModel: 'nomic-embed-text',
      embeddingBaseUrl: 'http://localhost:11434/v1',
      embeddingApiKey: 'sk-embed-secret',
    });
    expect(created.status).toBe(200);
    const body = created.body as {
      id?: string;
      embeddingModel?: string;
      embeddingBaseUrl?: string;
      hasEmbeddingKey?: boolean;
      embeddingApiKey?: unknown;
    };
    expect(body.embeddingModel).toBe('nomic-embed-text');
    expect(body.embeddingBaseUrl).toBe('http://localhost:11434/v1');
    expect(body.hasEmbeddingKey).toBe(true);
    expect(body).not.toHaveProperty('embeddingApiKey');
    const id = body.id!;
    try {
      await j('POST', `/api/v1/providers/${id}/activate`);
      const after = await j('GET', '/api/v1/ai/status');
      expect(after.status).toBe(200);
      expect((after.body.embedding as { mode?: string }).mode).toBe('api');
      expect((after.body.embedding as { model?: string }).model).toBe('nomic-embed-text');
      expect((after.body.active as { embeddingBaseUrl?: string }).embeddingBaseUrl).toBe(
        'http://localhost:11434/v1',
      );
    } finally {
      await j('DELETE', `/api/v1/providers/${id}`);
    }
  });

  it('validates required fields and rejects unknown ids', async () => {
    const bad = await j('POST', '/api/v1/providers', { name: 'nope' });
    expect(bad.status).toBe(400);

    const missing = await j('DELETE', '/api/v1/providers/prov_missing');
    expect(missing.status).toBe(404);
  });

  it('probe test fails fast against an unreachable endpoint', async () => {
    const created = await j('POST', '/api/v1/providers', {
      name: 'Unreachable',
      baseUrl: 'http://127.0.0.1:1',
      model: 'x',
    });
    const id = (created.body as { id?: string }).id!;
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/providers/${id}/test`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe('string');
    } finally {
      await j('DELETE', `/api/v1/providers/${id}`);
    }
  });
});

describe('auth', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;
  beforeAll(async () => {
    handle = await createServer(testConfig({ apiToken: 'sekrit' }));
    app = handle.app;
    await app.ready();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('rejects without bearer token', async () => {
    // health stays public; protected routes require bearer when apiToken is set
    const res = await app.inject({ method: 'GET', url: '/api/v1/units' });
    expect(res.statusCode).toBe(401);
  });
  it('accepts with correct bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { authorization: 'Bearer sekrit' },
    });
    expect(res.statusCode).toBe(200);
  });
  it('legacy token: explicit header to unknown workspace returns 403, not fallback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/units',
      headers: { authorization: 'Bearer sekrit', 'x-amem-workspace': 'no-such-ws' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

});

describe('workspaces + PAT auth', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await createServer(
      testConfig({
        authEnabled: true,
        authSecret: 'test-secret-at-least-16-chars',
        bootstrapAdminEmail: 'admin@test.local',
        bootstrapAdminPassword: 'admin-pass',
        allowLegacyApiToken: false,
        apiToken: undefined,
      }),
    );
    app = handle.app;
    await app.ready();
  });
  afterAll(async () => {
    await handle.close();
  });

  async function j(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });
    let data: unknown = null;
    try {
      data = res.json();
    } catch {
      data = res.body;
    }
    return { status: res.statusCode, body: data };
  }

  it('bootstraps admin PAT via login and isolates workspaces', async () => {
    const login = await j('POST', '/api/v1/auth/login', {
      email: 'admin@test.local',
      password: 'admin-pass',
      tokenName: 'test',
    });
    expect(login.status).toBe(200);
    const token = (login.body as { token: string }).token;
    expect(token.startsWith('amem_pat_')).toBe(true);

    const denied = await j('GET', '/api/v1/units');
    expect(denied.status).toBe(401);

    const auth = { authorization: `Bearer ${token}` };
    const ok = await j('GET', '/api/v1/me', undefined, auth);
    expect(ok.status).toBe(200);

    // write into personal
    const ing = await j(
      'POST',
      '/api/v1/ingest',
      {
        title: 'personal secret',
        content: 'Decision: personal workspace holds private notes about Project Alpha budget.',
      },
      auth,
    );
    expect(ing.status).toBe(200);

    // create company workspace
    const ws = await j(
      'POST',
      '/api/v1/workspaces',
      { slug: 'acme', name: 'Acme Corp', kind: 'company' },
      auth,
    );
    expect(ws.status).toBe(200);
    const wsId = (ws.body as { id: string }).id;

    // mint PAT scoped only to acme
    const pat = await j(
      'POST',
      '/api/v1/auth/tokens',
      { name: 'acme-only', scopes: ['read', 'write'], workspaceIds: [wsId] },
      auth,
    );
    expect(pat.status).toBe(200);
    const acmeToken = (pat.body as { token: string }).token;

    // write into acme
    const acmeWrite = await j(
      'POST',
      '/api/v1/ingest',
      {
        title: 'acme note',
        content: 'Decision: Acme Corp uses Amem for company knowledge isolation testing.',
      },
      { authorization: `Bearer ${acmeToken}`, 'x-amem-workspace': 'acme' },
    );
    expect(acmeWrite.status).toBe(200);

    // personal token listing should not see acme-only content when on personal ws
    const personalUnits = await j('GET', '/api/v1/units', undefined, {
      ...auth,
      'x-amem-workspace': 'personal',
    });
    expect(personalUnits.status).toBe(200);
    const pTitles = ((personalUnits.body as Array<{ title: string }>) || []).map((u) => u.title).join(' | ');
    expect(pTitles.toLowerCase()).toMatch(/personal|alpha|budget/);
    // acme-scoped list
    const acmeUnits = await j('GET', '/api/v1/units', undefined, {
      authorization: `Bearer ${acmeToken}`,
      'x-amem-workspace': 'acme',
    });
    expect(acmeUnits.status).toBe(200);
    const aTitles = ((acmeUnits.body as Array<{ title: string }>) || []).map((u) => u.title).join(' | ');
    expect(aTitles.toLowerCase()).toContain('acme');
    expect(aTitles).not.toContain('personal secret');
  });

  it('returns 403 (not silent fallback) when the workspace header targets an unauthorized workspace', async () => {
    const login = await j('POST', '/api/v1/auth/login', {
      email: 'admin@test.local',
      password: 'admin-pass',
      tokenName: 'forbidden-header',
    });
    expect(login.status).toBe(200);
    const adminToken = (login.body as { token: string }).token;

    // mint PAT limited to a fresh workspace "ws-a"
    const wsA = await j(
      'POST',
      '/api/v1/workspaces',
      { slug: 'ws-a', name: 'Workspace A', kind: 'company' },
      { authorization: `Bearer ${adminToken}` },
    );
    expect(wsA.status).toBe(200);
    const wsAId = (wsA.body as { id: string }).id;
    const pat = await j(
      'POST',
      '/api/v1/auth/tokens',
      { name: 'ws-a-only', scopes: ['read', 'write'], workspaceIds: [wsAId] },
      { authorization: `Bearer ${adminToken}` },
    );
    expect(pat.status).toBe(200);
    const wsAToken = (pat.body as { token: string }).token;

    // authorized header still works
    const ok = await j('GET', '/api/v1/units', undefined, {
      authorization: `Bearer ${wsAToken}`,
      'x-amem-workspace': 'ws-a',
    });
    expect(ok.status).toBe(200);

    // explicit header to a workspace outside the PAT scope -> 403, never fallback
    const denied = await j('GET', '/api/v1/units', undefined, {
      authorization: `Bearer ${wsAToken}`,
      'x-amem-workspace': 'acme',
    });
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    // explicit header to a nonexistent workspace -> 403, never fallback
    const missing = await j('GET', '/api/v1/units', undefined, {
      authorization: `Bearer ${wsAToken}`,
      'x-amem-workspace': 'no-such-workspace',
    });
    expect(missing.status).toBe(403);
    expect((missing.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    // no header still falls back to the PAT's first workspace (backward compat)
    const noHeader = await j('GET', '/api/v1/units', undefined, {
      authorization: `Bearer ${wsAToken}`,
    });
    expect(noHeader.status).toBe(200);
  });
});

describe('open mode workspace header enforcement', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await createServer(
      testConfig({
        authEnabled: false,
        authSecret: 'open-secret-at-least-16-chars',
        allowLegacyApiToken: true,
        apiToken: undefined,
      }),
    );
    app = handle.app;
    await app.ready();
  });
  afterAll(async () => {
    await handle.close();
  });

  async function j(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });
    let data: unknown = null;
    try {
      data = res.json();
    } catch {
      data = res.body;
    }
    return { status: res.statusCode, body: data };
  }

  it('honors an explicit workspace header even with auth disabled', async () => {
    // bootstrap -> admin PAT on the personal workspace
    const boot = await j('POST', '/api/v1/auth/bootstrap', {
      email: 'open@test.local',
      password: 'open-pass',
      tokenName: 'open-admin',
    });
    expect(boot.status).toBe(200);
    const adminToken = (boot.body as { token: string }).token;

    // create a company workspace
    const ws = await j(
      'POST',
      '/api/v1/workspaces',
      { slug: 'acme', name: 'Acme Corp', kind: 'company' },
      { authorization: `Bearer ${adminToken}` },
    );
    expect(ws.status).toBe(200);
    const wsId = (ws.body as { id: string }).id;

    // mint a PAT scoped only to acme
    const pat = await j(
      'POST',
      '/api/v1/auth/tokens',
      { name: 'acme-only', scopes: ['read', 'write'], workspaceIds: [wsId] },
      { authorization: `Bearer ${adminToken}` },
    );
    expect(pat.status).toBe(200);
    const acmeToken = (pat.body as { token: string }).token;

    // data lands in acme when the header says so
    const write = await j(
      'POST',
      '/api/v1/ingest',
      { title: 'acme open note', content: 'Acme deploys via Argo CD in open mode.' },
      { authorization: `Bearer ${acmeToken}`, 'x-amem-workspace': 'acme' },
    );
    expect(write.status).toBe(200);

    // explicit header outside the PAT scope -> 403, never silent fallback
    const denied = await j('GET', '/api/v1/units', undefined, {
      authorization: `Bearer ${acmeToken}`,
      'x-amem-workspace': 'personal',
    });
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    // nonexistent workspace with explicit header -> 403 even without a credential
    const missing = await j('GET', '/api/v1/units', undefined, {
      'x-amem-workspace': 'no-such-workspace',
    });
    expect(missing.status).toBe(403);

    // no header, no credential -> anonymous default workspace still works (backward compat)
    const open = await j('GET', '/api/v1/units');
    expect(open.status).toBe(200);

    // valid credential + authorized header still works
    const ok = await j('GET', '/api/v1/units', undefined, {
      authorization: `Bearer ${acmeToken}`,
      'x-amem-workspace': 'acme',
    });
    expect(ok.status).toBe(200);
    const titles = ((ok.body as Array<{ title: string }>) || []).map((u) => u.title).join(' | ');
    expect(titles.toLowerCase()).toContain('acme');
  });
});

describe('oauth pkce', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await createServer(
      testConfig({
        authEnabled: true,
        authSecret: 'oauth-secret-16chars-min',
        bootstrapAdminEmail: 'oauth@test.local',
        bootstrapAdminPassword: 'oauth-pass',
        allowLegacyApiToken: false,
        apiToken: undefined,
        rateLimit: { enabled: true, oauthPerMinute: 500 },
      }),
    );
    app = handle.app;
    await app.ready();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('authorization_code + PKCE S256 yields access token', async () => {
    const meta = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().code_challenge_methods_supported).toContain('S256');
    expect(meta.json().registration_endpoint).toContain('/oauth/register');

    const prm = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    expect(prm.statusCode).toBe(200);
    expect(prm.json().resource).toContain('/mcp');

    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        client_name: 'codex-test',
        redirect_uris: ['http://127.0.0.1:1455/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.json().client_id).toBeTruthy();


    const verifier = 'a'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirect = 'http://127.0.0.1:8321/oauth/callback';

    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        email: 'oauth@test.local',
        password: 'oauth-pass',
        client_id: 'amem-web',
        redirect_uri: redirect,
        state: 'xyz',
        scope: 'read write',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
    });
   expect(authz.statusCode).toBe(302);
   // Step 2: consent page redirects to GET /oauth/authorize
   const consentLoc = authz.headers.location as string;
   expect(consentLoc).toContain('/oauth/authorize');
   const sessionCookie = authz.headers['set-cookie'] as string;
   expect(sessionCookie).toBeTruthy();
   // Step 3: follow consent page (auto-approved because session exists)
   const consentGet = await app.inject({
     method: 'GET',
     url: consentLoc,
     headers: { cookie: sessionCookie },
   });
   expect(consentGet.statusCode).toBe(200);
   // Step 4: POST consent approval
   const approve = await app.inject({
     method: 'POST',
     url: '/oauth/consent',
     headers: {
       'content-type': 'application/x-www-form-urlencoded',
       cookie: sessionCookie,
     },
     payload: new URLSearchParams({
       client_id: 'amem-web',
       redirect_uri: redirect,
       state: 'xyz',
       scope: 'read write',
       code_challenge: challenge,
       code_challenge_method: 'S256',
     }).toString(),
   });
   expect(approve.statusCode).toBe(302);
   const codeLoc = approve.headers.location as string;
   expect(codeLoc).toContain('code=');
   const code = new URL(codeLoc).searchParams.get('code');
   expect(code).toBeTruthy();

    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirect,
        client_id: 'amem-web',
        code_verifier: verifier,
      }).toString(),
    });
    expect(tok.statusCode).toBe(200);
    const body = tok.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token.startsWith('amem_atk_')).toBe(true);
    expect(body.refresh_token.startsWith('amem_rtk_')).toBe(true);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('oauth@test.local');
  });

  it('rejects wrong PKCE verifier and burns the code on first exchange', async () => {
    const verifier = 'a'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirect = 'http://127.0.0.1:8321/oauth/callback';

    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        email: 'oauth@test.local',
        password: 'oauth-pass',
        client_id: 'amem-web',
        redirect_uri: redirect,
        state: 'neg',
        scope: 'read write',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
    });
    expect(authz.statusCode).toBe(302);
    const sessionCookie = authz.headers['set-cookie'] as string;
    const consentLoc = authz.headers.location as string;

    const consentGet = await app.inject({
      method: 'GET',
      url: consentLoc,
      headers: { cookie: sessionCookie },
    });
    expect(consentGet.statusCode).toBe(200);

    const approve = await app.inject({
      method: 'POST',
      url: '/oauth/consent',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: sessionCookie,
      },
      payload: new URLSearchParams({
        client_id: 'amem-web',
        redirect_uri: redirect,
        state: 'neg',
        scope: 'read write',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
    });
    expect(approve.statusCode).toBe(302);
    const code = new URL(approve.headers.location as string).searchParams.get('code');
    expect(code).toBeTruthy();

    // Wrong verifier must be rejected…
    const wrong = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirect,
        client_id: 'amem-web',
        code_verifier: 'z'.repeat(64),
      }).toString(),
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.message).toContain('PKCE');

    // …and the same code must be burned even by the failed attempt (one-time).
    const replay = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirect,
        client_id: 'amem-web',
        code_verifier: verifier,
      }).toString(),
    });
    expect(replay.statusCode).toBe(401);
  });

  it('rotates refresh tokens and revokes family on reuse', async () => {
    const verifier = 'b'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirect = 'http://127.0.0.1:8321/oauth/callback';
    const p = new URLSearchParams({
      email: 'oauth@test.local',
      password: 'oauth-pass',
      client_id: 'amem-web',
      redirect_uri: redirect,
      state: 'rot',
      scope: 'read write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: p.toString(),
    });
    const cookie = authz.headers['set-cookie'] as string;
    const approve = await app.inject({
      method: 'POST',
      url: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: new URLSearchParams({
        client_id: 'amem-web',
        redirect_uri: redirect,
        state: 'rot',
        scope: 'read write',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
    });
    const codeLoc = approve.headers.location as string;
    const code = new URL(codeLoc).searchParams.get('code');
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirect,
        client_id: 'amem-web',
        code_verifier: verifier,
      }).toString(),
    });
    const pairA = tok.json() as { refresh_token: string };

    // First refresh rotates: old token revoked, new pair issued.
    const rot1 = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: pairA.refresh_token,
        client_id: 'amem-web',
      }).toString(),
    });
    expect(rot1.statusCode).toBe(200);
    const pairB = rot1.json() as { refresh_token: string };
    expect(pairB.refresh_token).not.toBe(pairA.refresh_token);

    // Replaying pairA is a reuse signal: family burned, pairB revoked too.
    const replay = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: pairA.refresh_token,
        client_id: 'amem-web',
      }).toString(),
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.message).toContain('reused');

    const burnB = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: pairB.refresh_token,
        client_id: 'amem-web',
      }).toString(),
    });
    expect(burnB.statusCode).toBe(401);
  });

  it('lists and revokes active sessions', async () => {
    const verifier = 'c'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirect = 'http://127.0.0.1:8321/oauth/callback';
    const p = new URLSearchParams({
      email: 'oauth@test.local',
      password: 'oauth-pass',
      client_id: 'amem-web',
      redirect_uri: redirect,
      state: 'sess',
      scope: 'read write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: p.toString(),
    });
    const cookie = authz.headers['set-cookie'] as string;
    const approve = await app.inject({
      method: 'POST',
      url: '/oauth/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: new URLSearchParams({
        client_id: 'amem-web',
        redirect_uri: redirect,
        state: 'sess',
        scope: 'read write',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
    });
    const code = new URL(approve.headers.location as string).searchParams.get('code');
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirect,
        client_id: 'amem-web',
        code_verifier: verifier,
      }).toString(),
    });
    const access = (tok.json() as { access_token: string }).access_token;
    const auth = { authorization: `Bearer ${access}` };

    // Use a PAT (created by login) for session management so we can still
    // list sessions after the OAuth family is revoked.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'oauth@test.local', password: 'oauth-pass' }),
    });
    expect(login.statusCode).toBe(200);
    const pat = (login.json() as { token: string }).token;
    const patAuth = { authorization: `Bearer ${pat}` };

    const list = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: patAuth });
    expect(list.statusCode).toBe(200);
    const sessions = list.json() as Array<{ id: string; kind: string; type?: string }>;
    expect(sessions.some((s) => s.kind === 'login')).toBe(true);
    expect(sessions.some((s) => s.kind === 'oauth' && s.type === 'refresh')).toBe(true);

    const oauthSession = sessions.find((s) => s.kind === 'oauth');
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${oauthSession!.id}`,
      headers: patAuth,
    });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: patAuth });
    const ids = (after.json() as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain(oauthSession!.id);

    // The revoked family's access token must no longer authenticate.
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: auth });
    expect(me.statusCode).toBe(401);
  });
});

describe('mcp oauth http', () => {
  it('challenges unauthenticated MCP and accepts PAT after initialize', async () => {
    const prev = process.env.AMEM_MCP_OAUTH;
    process.env.AMEM_MCP_OAUTH = '1';
    const handle = await createServer(
      testConfig({
        authEnabled: true,
        authSecret: 'mcp-oauth-secret16',
        bootstrapAdminEmail: 'mcp@test.local',
        bootstrapAdminPassword: 'mcp-pass',
      }),
    );
    const app = handle.app;
    await app.ready();
    try {
      const unauth = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        },
      });
      expect(unauth.statusCode).toBe(401);
      expect(String(unauth.headers['www-authenticate'] || '')).toContain('resource_metadata');

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'mcp@test.local', password: 'mcp-pass' },
      });
      expect(login.statusCode).toBe(200);
      const pat = login.json().token as string;

      const init = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${pat}`,
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        },
      });
      expect(init.statusCode).toBe(200);
      const sid = init.headers['mcp-session-id'];
      expect(sid).toBeTruthy();

      // second initialize must not crash (per-session McpServer)
      const init2 = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${pat}`,
        },
        payload: {
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 't2', version: '0' },
          },
        },
      });
      expect(init2.statusCode).toBe(200);
      expect(init2.headers['mcp-session-id']).toBeTruthy();
      expect(init2.headers['mcp-session-id']).not.toBe(sid);

      const prm = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
      expect(prm.statusCode).toBe(200);
      expect(prm.json().authorization_servers?.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.AMEM_MCP_OAUTH;
      else process.env.AMEM_MCP_OAUTH = prev;
      await handle.close();
    }
  });
});

describe('workspace members', () => {
  it('lists and adds members for owners', async () => {
    const handle = await createServer(
      testConfig({
        authEnabled: true,
        authSecret: 'members-secret-16c',
        bootstrapAdminEmail: 'owner@test.local',
        bootstrapAdminPassword: 'owner-pass',
      }),
    );
    const app = handle.app;
    await app.ready();
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'owner@test.local', password: 'owner-pass' },
      });
      expect(login.statusCode).toBe(200);
      const pat = login.json().token as string;
      const headers = { authorization: `Bearer ${pat}` };

      // second bootstrap login is blocked; member added via workspaces API below.
      // Create company workspace and ensure owner is member.
      const ws = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers,
        payload: { slug: 'acme', name: 'Acme', kind: 'company' },
      });
      expect(ws.statusCode).toBe(200);
      const slug = ws.json().slug as string;

      const members = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${slug}/members`,
        headers,
      });
      expect(members.statusCode).toBe(200);
      expect(members.json().length).toBeGreaterThanOrEqual(1);

      // unknown email via POST members => 404 (no storage side-effects)
      const missing = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${slug}/members`,
        headers,
        payload: { email: 'ghost@test.local', role: 'member' },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe("admin db-health", () => {
  it("returns integrity status", async () => {
    const handle = await createServer(testConfig());
    const app = handle.app;
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/admin/db-health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().status === "ok" || res.json().status === "ok-after-fts-rebuild").toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("stays healthy while the main connection is actively writing", async () => {
    // Regression: the probe must run on the server's own connection. A second
    // connection doing `PRAGMA journal_mode` can fail with SQLITE_IOERR
    // (e.g. virtiofs bind mounts) while the primary writer is live.
    const handle = await createServer(testConfig());
    const app = handle.app;
    await app.ready();
    try {
      for (let i = 0; i < 3; i++) {
        const w = await app.inject({
          method: 'POST',
          url: '/api/v1/ingest',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({
            sessionId: `health-write-${i}-${Date.now()}`,
            title: 'Health probe write',
            content: `Fact number ${i}: the quick brown fox jumps over the lazy dog near the amem health check.`,
          }),
        });
        expect(w.statusCode).toBe(200);
        const res = await app.inject({ method: 'GET', url: '/api/v1/admin/db-health' });
        expect(res.statusCode).toBe(200);
        const h = res.json();
        expect(h.ok).toBe(true);
        expect(h.journal).toBe('truncate');
        expect(typeof h.units).toBe('number');
      }
    } finally {
      await handle.close();
    }
  });
});

describe('auth rate limiting', () => {
  it('returns 429 RATE_LIMITED once login exceeds the per-IP limit', async () => {
    const handle = await createServer(
      testConfig({
        authEnabled: true,
        authSecret: 'ratelimit-secret-16chars',
        bootstrapAdminEmail: 'rl@test.local',
        bootstrapAdminPassword: 'rl-pass',
        allowLegacyApiToken: false,
        apiToken: undefined,
        trustProxy: true,
        rateLimit: { enabled: true, loginPerMinute: 2 },
      }),
    );
    const app = handle.app;
    await app.ready();
    try {
      const attempt = () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ email: 'rl@test.local', password: 'wrong-pass' }),
        });
      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(401);
      const third = await attempt();
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RATE_LIMITED');
      // A different IP is not affected.
      const other = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.9',
        },
        payload: JSON.stringify({ email: 'rl@test.local', password: 'wrong-pass' }),
      });
      expect(other.statusCode).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('can be disabled via config', async () => {
    const handle = await createServer(
      testConfig({
        rateLimit: { enabled: false },
      }),
    );
    const app = handle.app;
    await app.ready();
    try {
      for (let i = 0; i < 30; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ email: 'nobody@test.local', password: 'x' }),
        });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await handle.close();
    }
  });
});

describe('auth audit logging + cookie security', () => {
  it('records failed logins and sets Secure cookies when configured', async () => {
    const handle = await createServer(
      testConfig({
        authEnabled: true,
        authSecret: 'audit-secret-16chars-min',
        bootstrapAdminEmail: 'audit@test.local',
        bootstrapAdminPassword: 'audit-pass',
        allowLegacyApiToken: false,
        apiToken: undefined,
        cookieSecure: true,
        rateLimit: { enabled: true, loginPerMinute: 100 },
      }),
    );
    const app = handle.app;
    await app.ready();
    try {
      // Failed REST login → 401 and an audit event
      const bad = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'audit@test.local', password: 'wrong-pass' }),
      });
      expect(bad.statusCode).toBe(401);

      // Successful login returns a PAT (the feed query below needs one)
      const ok = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'audit@test.local', password: 'audit-pass' }),
      });
      expect(ok.statusCode).toBe(200);
      const pat = (ok.json() as { token: string }).token;
      expect(pat).toMatch(/^amem_pat_/);

      const feed = await app.inject({
        method: 'GET',
        url: '/api/v1/activity?kind=auth_login_failed',
        headers: { authorization: `Bearer ${pat}` },
      });
      expect(feed.statusCode).toBe(200);
      const events = feed.json() as Array<{ kind: string; summary: string }>;
      expect(
        events.some(
          (e) => e.kind === 'auth_login_failed' && e.summary.includes('audit@test.local'),
        ),
      ).toBe(true);

      // OAuth login sets HttpOnly + SameSite=Lax, plus Secure when enabled
      const authz = await app.inject({
        method: 'POST',
        url: '/oauth/authorize',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          email: 'audit@test.local',
          password: 'audit-pass',
          client_id: 'amem-web',
          redirect_uri: 'http://127.0.0.1:8321/oauth/callback',
          state: 's',
          scope: 'read write',
          code_challenge: createHash('sha256').update('b'.repeat(64)).digest('base64url'),
          code_challenge_method: 'S256',
        }).toString(),
      });
      expect(authz.statusCode).toBe(302);
      const cookie = String(authz.headers['set-cookie']);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Secure');
    } finally {
      await handle.close();
    }
  });
});
