import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AmemConfig } from '@amem/core';
import { createServer, type ServerHandle } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

function testConfig(overrides: Partial<AmemConfig> = {}): AmemConfig {
  return {
    dbPath: join(mkdtempSync(join(tmpdir(), 'amem-wf-')), 'test.db'),
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

async function boot(overrides: Partial<AmemConfig> = {}): Promise<{ app: FastifyInstance; handle: ServerHandle; dbPath: string }> {
  const config = testConfig(overrides);
  const handle = await createServer(config);
  await handle.app.ready();
  return { app: handle.app, handle, dbPath: config.dbPath };
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

describe('Amem real-workflow (real SQLite, offline)', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;

  afterAll(async () => {
    await handle?.close();
  });

  it('supports a full day-of-use knowledge lifecycle', async () => {
    ({ app, handle } = await boot());

    // 1. Ingest two related facts -> auto-distil + auto-link.
    const f1 = await j(app, 'POST', '/api/v1/ingest', {
      title: 'Amem 是什么',
      content: 'Amem 是一个基于知识图谱的记忆知识管理系统，帮助 AI Agent 减少上下文浪费与幻觉。',
    });
    expect(f1.status).toBe(200);
    expect((f1.body as { units: unknown[] }).units.length).toBeGreaterThan(0);

    const f2 = await j(app, 'POST', '/api/v1/ingest', {
      title: 'Amem 的记忆整理',
      content: 'Amem 会自动对相似知识去重合并、生成知识图谱连接，并持续提升长期记忆质量。',
    });
    expect(f2.status).toBe(200);
    const ids = [
      (f1.body as { units: { id: string }[] }).units[0].id,
      (f2.body as { units: { id: string }[] }).units[0].id,
    ];

    // 2. Search finds the knowledge.
    const search = await j(app, 'GET', '/api/v1/search?q=%E8%AE%B0%E5%BF%86%E7%B3%BB%E7%BB%9F');
    expect(search.status).toBe(200);
    expect((search.body as { items: unknown[] }).items.length).toBeGreaterThan(0);

    // 3. Recall returns a token-budgeted, grounded context block.
    const recall = await j(app, 'POST', '/api/v1/recall', { query: 'Amem 记忆', tokenBudget: 500 });
    expect(recall.status).toBe(200);
    const r = recall.body as { usedTokens: number; budget: number; items: unknown[]; text: string };
    expect(r.usedTokens).toBeLessThanOrEqual(r.budget);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.text).toContain('[unit:');

    // 4. Working-memory briefing respects its budget.
    const wm = await j(app, 'GET', '/api/v1/working-memory?budget=600');
    expect(wm.status).toBe(200);
    const w = wm.body as { tokenCount: number };
    expect(w.tokenCount).toBeLessThanOrEqual(600);

    // 5. Knowledge graph is populated — explicit typed link lands as an edge.
    const link = await j(app, 'POST', '/api/v1/links', {
      sourceUnitId: ids[0],
      targetUnitId: ids[1],
      relation: 'related_to',
    });
    expect(link.status).toBe(200);
    const graph = await j(app, 'GET', '/api/v1/graph');
    expect(graph.status).toBe(200);
    const g = graph.body as { nodes: unknown[]; links: unknown[] };
    expect(g.nodes.length).toBeGreaterThanOrEqual(2);
    expect(g.links.length).toBeGreaterThanOrEqual(1);

    // 6. Consolidation/curation runs without error.
    const curate = await j(app, 'POST', '/api/v1/curate');
    expect([200, 201]).toContain(curate.status);

    // 7. Full export (JSON) includes units, traces, and links.
    const exp = await j(app, 'GET', '/api/v1/export');
    expect(exp.status).toBe(200);
    const e = exp.body as { units: unknown[]; traces: unknown[]; links: unknown[] };
    expect(e.units.length).toBeGreaterThanOrEqual(2);
    expect(e.traces.length).toBeGreaterThanOrEqual(2);
    expect(e.links.length).toBeGreaterThanOrEqual(1);

    // 8. Stats reflect the accumulated knowledge.
    const stats = await j(app, 'GET', '/api/v1/stats');
    const s = stats.body as { counts: { units: number; traces: number; links: number } };
    expect(s.counts.units).toBeGreaterThanOrEqual(2);
    expect(s.counts.traces).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates repeated knowledge and reports token savings', async () => {
    ({ app, handle } = await boot());
    const payload = {
      title: '重复的知识',
      content: '数据库使用 SQLite，以 WAL 模式运行，支持离线全文检索与向量检索。',
    };
    const first = await j(app, 'POST', '/api/v1/ingest', { ...payload, autoLink: false });
    const firstBody = first.body as { units: unknown[] };
    expect(firstBody.units.length).toBe(1);

    const second = await j(app, 'POST', '/api/v1/ingest', { ...payload, autoLink: false });
    const secondBody = second.body as {
      units: unknown[];
      deduplicated: unknown[];
      tokensSavedByDedup: number;
    };
    expect(secondBody.units.length).toBe(0);
    expect(secondBody.deduplicated.length).toBeGreaterThanOrEqual(1);
    expect(secondBody.tokensSavedByDedup).toBeGreaterThan(0);

    // Only one physical unit exists despite two ingests.
    const units = await j(app, 'GET', '/api/v1/units');
    expect((units.body as unknown[]).length).toBe(1);

    const stats = await j(app, 'GET', '/api/v1/stats');
    const s = stats.body as { tokensSavedByDedup: number; counts: { units: number } };
    expect(s.tokensSavedByDedup).toBeGreaterThan(0);
    expect(s.counts.units).toBe(1);
  });

  it('persists knowledge across a server restart (durability)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'amem-dur-')), 'test.db');

    let h = await boot({ dbPath });
    await j(h.app, 'POST', '/api/v1/ingest', {
      title: '重启前的知识',
      content: '这条记忆必须跨越服务重启依然存在，才能证明数据库持久化可靠。',
    });
    await h.handle.close();

    // Boot a brand-new server process against the same SQLite file.
    h = await boot({ dbPath });
    const units = await j(h.app, 'GET', '/api/v1/units');
    expect((units.body as unknown[]).length).toBe(1);
    const search = await j(h.app, 'GET', '/api/v1/search?q=%E9%87%8D%E5%90%AF');
    expect((search.body as { items: unknown[] }).items.length).toBeGreaterThan(0);
    await h.handle.close();
  });

  it('tolerates empty JSON bodies and rejects malformed JSON cleanly', async () => {
    ({ app, handle } = await boot());

    // Empty body + JSON content-type (realistic curl/agent client) must not 500.
    const curate = await app.inject({
      method: 'POST',
      url: '/api/v1/curate',
      payload: '',
      headers: { 'content-type': 'application/json' },
    });
    expect(curate.statusCode).toBe(200);

    // Malformed JSON must be a clean 400, not an unhandled 500.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      payload: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
