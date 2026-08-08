import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AmemConfig } from '@amem/core';
import { createServer, type ServerHandle } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

function testConfig(overrides: Partial<AmemConfig> = {}): AmemConfig {
  return {
    dbPath: join(mkdtempSync(join(tmpdir(), 'amem-cls-')), 'test.db'),
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

async function boot(overrides: Partial<AmemConfig> = {}): Promise<{ app: FastifyInstance; handle: ServerHandle }> {
  const config = testConfig(overrides);
  const handle = await createServer(config);
  await handle.app.ready();
  return { app: handle.app, handle };
}

async function j(app: FastifyInstance, method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  let data: unknown = null;
  try {
    data = res.json();
  } catch {
    data = res.body;
  }
  return { status: res.statusCode, body: data };
}

describe('unit classification & batch management (REST)', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;

  afterAll(async () => {
    await handle?.close();
  });

  it('auto-classifies on save and filters by category', async () => {
    ({ app, handle } = await boot());

    const code = await j(app, 'POST', '/api/v1/units', {
      unit: { type: 'fact', title: 'function: queryTerms — layeredRecall.ts', summary: 'term extraction', body: 'body' },
    });
    expect(code.status).toBe(200);
    expect((code.body as { labels: Record<string, string> }).labels.category).toBe('code');

    const infra = await j(app, 'POST', '/api/v1/units', {
      unit: { type: 'fact', title: 'Deploy with docker compose', summary: 'one-command deploy', body: 'body' },
    });
    expect(infra.status).toBe(200);
    expect((infra.body as { labels: Record<string, string> }).labels.category).toBe('infra');

    const filtered = await j(app, 'GET', '/api/v1/units?category=code&limit=50');
    expect(filtered.status).toBe(200);
    const list = filtered.body as Array<{ title: string; category?: string }>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((u) => u.category === 'code')).toBe(true);
  });

  it('classify endpoint reports byCategory and persists labels', async () => {
    ({ app, handle } = await boot());
    const u1 = await j(app, 'POST', '/api/v1/units', {
      unit: { type: 'fact', title: 'A random fact without keywords', summary: 's', body: 'b' },
    });
    const u2 = await j(app, 'POST', '/api/v1/units', {
      unit: { type: 'fact', title: 'function: helper — mod.ts', summary: 's', body: 'b' },
    });
    const id1 = (u1.body as { id: string }).id;
    const id2 = (u2.body as { id: string }).id;

    // Both were already auto-classified on save (other + code). Re-run with
    // reclassify to force the rule engine through the endpoint.
    const res = await j(app, 'POST', '/api/v1/units/classify', { mode: 'rules', reclassify: true });
    expect(res.status).toBe(200);
    const report = res.body as { examined: number; classified: number; byCategory: Record<string, number>; persisted: number };
    expect(report.examined).toBe(2);
    expect(report.classified).toBe(2);
    expect(report.byCategory.code).toBe(1);
    expect(report.byCategory.other).toBe(1);
    expect(report.persisted).toBe(0); // labels already match

    const fresh = await j(app, 'GET', '/api/v1/units');
    const units = fresh.body as Array<{ id: string; category?: string }>;
    expect(units.find((u) => u.id === id1)?.category).toBe('other');
    expect(units.find((u) => u.id === id2)?.category).toBe('code');
  });

  it('batch archives, restores, accepts, and deletes', async () => {
    ({ app, handle } = await boot());
    const a = await j(app, 'POST', '/api/v1/units', { unit: { type: 'fact', title: 'A', summary: 's', body: 'b' } });
    const b = await j(app, 'POST', '/api/v1/units', { unit: { type: 'fact', title: 'B', summary: 's', body: 'b' } });
    const idA = (a.body as { id: string }).id;
    const idB = (b.body as { id: string }).id;

    const archive = await j(app, 'POST', '/api/v1/units/batch', { ids: [idA, idB], action: 'archive' });
    expect(archive.status).toBe(200);
    expect((archive.body as { affected: number }).affected).toBe(2);

    const afterArchive = await j(app, 'GET', `/api/v1/units/${idA}`);
    expect((afterArchive.body as { status: string }).status).toBe('archived');

    const restore = await j(app, 'POST', '/api/v1/units/batch', { ids: [idA], action: 'restore' });
    expect((restore.body as { affected: number }).affected).toBe(1);
    const afterRestore = await j(app, 'GET', `/api/v1/units/${idA}`);
    expect((afterRestore.body as { status: string }).status).toBe('reviewed');

    const accept = await j(app, 'POST', '/api/v1/units/batch', { ids: [idB], action: 'accept' });
    expect((accept.body as { affected: number }).affected).toBe(1);

    const del = await j(app, 'POST', '/api/v1/units/batch', { ids: [idB], action: 'delete' });
    expect((del.body as { affected: number }).affected).toBe(1);
    const gone = await j(app, 'GET', `/api/v1/units/${idB}`);
    expect(gone.status).toBe(404);
  });

  it('rejects empty batch and archives are excluded from the active graph', async () => {
    ({ app, handle } = await boot());
    const bad = await j(app, 'POST', '/api/v1/units/batch', { ids: [], action: 'archive' });
    expect(bad.status).toBe(400);

    const created = await j(app, 'POST', '/api/v1/units', { unit: { type: 'fact', title: 'C', summary: 's', body: 'b' } });
    const id = (created.body as { id: string }).id;
    await j(app, 'POST', '/api/v1/units/batch', { ids: [id], action: 'archive' });
    const graph = await j(app, 'GET', '/api/v1/graph');
    const g = graph.body as { nodes: Array<{ id: string }> };
    expect(g.nodes.some((n) => n.id === id)).toBe(false);
  });
});
