import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AmemConfig, ExportBundle } from '@amem/core';
import { createServer, type ServerHandle } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

function testConfig(overrides: Partial<AmemConfig> = {}): AmemConfig {
  return {
    dbPath: join(mkdtempSync(join(tmpdir(), 'amem-sov-')), 'test.db'),
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
  const handle = await createServer(testConfig(overrides));
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

describe('Amem data sovereignty (self-local-data)', () => {
  let a: FastifyInstance;
  let b: FastifyInstance;
  let ha: ServerHandle;
  let hb: ServerHandle;

  afterAll(async () => {
    await ha?.close();
    await hb?.close();
  });

  it('exports from one instance and imports into a fresh one with full fidelity', async () => {
    // Source instance: build knowledge.
    ({ app: a, handle: ha } = await boot());
    await j(a, 'POST', '/api/v1/ingest', {
      title: '迁移知识',
      content: '知识必须能够完整导出，并在另一台机器上原样恢复。',
    });
    await j(a, 'POST', '/api/v1/ingest', {
      title: '迁移知识补充',
      content: '知识导出后，可以与连接和图谱一起，在全新数据库中重建。',
    });

    const exp = await j(a, 'GET', '/api/v1/export');
    expect(exp.status).toBe(200);
    const bundle = exp.body as ExportBundle;
    expect(bundle.units.length).toBeGreaterThanOrEqual(2);
    expect(bundle.traces.length).toBeGreaterThanOrEqual(2);

    // Target instance: brand-new, empty database.
    ({ app: b, handle: hb } = await boot());
    const imp = await j(b, 'POST', '/api/v1/import', bundle);
    expect(imp.status).toBe(200);
    const imported = imp.body as { units: number; traces: number };
    expect(imported.units).toBe(bundle.units.length);
    expect(imported.traces).toBe(bundle.traces.length);

    // Fidelity: same unit count + links, and recall works on the new instance.
    const bStats = await j(b, 'GET', '/api/v1/stats');
    const bs = bStats.body as { counts: { units: number; traces: number; links: number } };
    expect(bs.counts.units).toBe(bundle.units.length);
    expect(bs.counts.traces).toBe(bundle.traces.length);
    expect(bs.counts.links).toBe(bundle.links.length);

    const recall = await j(b, 'POST', '/api/v1/recall', { query: '迁移知识', tokenBudget: 400 });
    expect(recall.status).toBe(200);
    const r = recall.body as { items: unknown[]; text: string };
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.text).toContain('[unit:');

    // Re-export from the target: unit set matches (self-local-data, portable).
    const reExp = await j(b, 'GET', '/api/v1/export');
    expect((reExp.body as ExportBundle).units.length).toBe(bundle.units.length);
  });

  it('renders an Open-Knowledge-Format (OKF) markdown export with an index', async () => {
    ({ app: a, handle: ha } = await boot());
    await j(a, 'POST', '/api/v1/ingest', { title: 'OKF 导出', content: '以 OKF 格式导出为可读的 Markdown 网页。' });

    const okf = await j(a, 'GET', '/api/v1/export/okf');
    expect(okf.status).toBe(200);
    const files = (okf.body as { files: Record<string, string> }).files;
    const names = Object.keys(files);
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names).toContain('index.md');
    // Every unit gets a Markdown page; pages reference the index graph.
    const page = names.find((n) => n.includes('/'));
    expect(page).toBeTruthy();
  });
});
