import { describe, expect, it } from 'vitest';
import {
  createService,
  extractCodegraph,
  extractWiki,
  mergeConfig,
  type AmemConfig,
  type Link,
  type Source,
  type Unit,
  type UnitSource,
} from '../src/index.js';
import { FakeStorage, iso, makeUnit } from './helpers.js';

function testConfig(): AmemConfig {
  return mergeConfig({
    embedding: { mode: 'offline', dims: 64 },
    jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 },
  });
}

function moduleUnit(over: Partial<Unit> & { id: string; title: string }): Unit {
  return makeUnit({
    type: 'concept',
    labels: { kind: 'module', lang: 'ts' },
    tags: ['ts', 'code', 'codegraph'],
    ...over,
  });
}

function symbolUnit(over: Partial<Unit> & { id: string; title: string }): Unit {
  return makeUnit({
    type: 'fact',
    labels: { kind: 'symbol', symbolKind: 'function' },
    tags: ['ts', 'code', 'codegraph', 'function'],
    ...over,
  });
}

function partOf(sourceUnitId: string, targetUnitId: string, id: string): Link {
  return {
    id, sourceUnitId, targetUnitId, relation: 'part_of',
    reason: 'symbol belongs to module', confidence: 0.9, auto: true, createdAt: iso(),
  };
}

describe('extractCodegraph (zero-LLM asset precipitation)', () => {
  it('groups module units by top-level dir and embeds symbols', async () => {
    const storage = new FakeStorage();
    const m1 = moduleUnit({
      id: 'm1', title: 'Module: src/app.ts',
      summary: 'Application entry', body: 'Path: src/app.ts\nSymbols: 1\n- function runApp (line 12)',
    });
    const m2 = moduleUnit({
      id: 'm2', title: 'Module: src/utils.ts',
      summary: 'Helpers', body: 'Path: src/utils.ts\nSymbols: 1\n- function clamp (line 3)',
    });
    const m3 = moduleUnit({
      id: 'm3', title: 'Module: test/fixture.ts',
      summary: 'Test fixture', body: 'Path: test/fixture.ts\nSymbols: 0',
    });
    const s1 = symbolUnit({
      id: 's1', title: 'function: runApp — src/app.ts',
      summary: 'runApp()', body: 'File: src/app.ts\nLine: 12\n\nrunApp()',
    });
    const s2 = symbolUnit({
      id: 's2', title: 'function: clamp — src/utils.ts',
      summary: 'clamp(n, min, max)', body: 'File: src/utils.ts\nLine: 3\n\nclamp(n, min, max)',
    });
    for (const u of [m1, m2, m3, s1, s2]) await storage.createUnit(u);
    await storage.createLink(partOf('m1', 's1', 'l1'));
    await storage.createLink(partOf('m2', 's2', 'l2'));

    const result = await extractCodegraph(storage);
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    const names = result.assets.map((a) => a.name).sort();
    expect(names).toEqual(['codegraph: src', 'codegraph: test']);

    const src = result.assets.find((a) => a.name === 'codegraph: src');
    expect(src?.kind).toBe('codegraph');
    expect(src?.sourceUnitIds.sort()).toEqual(['m1', 'm2']);
    const payload = JSON.parse(src?.content ?? '{}') as {
      scope: string;
      modules: Array<{ path: string; symbols: Array<{ name: string; line: number }> }>;
    };
    expect(payload.scope).toBe('src');
    expect(payload.modules).toHaveLength(2);
    const app = payload.modules.find((m) => m.path === 'src/app.ts');
    expect(app?.symbols).toEqual([{ name: 'runApp', kind: 'function', signature: 'runApp()', line: 12 }]);
    expect(src?.body).toContain('## src/app.ts');
    expect(src?.body).toContain('function runApp');
  });

  it('is idempotent: re-running updates instead of duplicating', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(moduleUnit({
      id: 'm1', title: 'Module: src/app.ts', summary: 'App', body: 'Path: src/app.ts\nSymbols: 0',
    }));
    const first = await extractCodegraph(storage);
    expect(first.created).toBe(1);

    const second = await extractCodegraph(storage);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    const all = await storage.listAssets({ kind: 'codegraph' });
    expect(all).toHaveLength(1);
  });
});

describe('extractWiki (zero-LLM asset precipitation)', () => {
  it('builds one wiki page per doc source uri', async () => {
    const storage = new FakeStorage();
    const src: Source = {
      id: 'src-doc', uri: 'docs/architecture.md', title: 'docs/architecture.md',
      kind: 'file', contentHash: 'h', contentLength: 10, createdAt: iso(),
    };
    await storage.upsertSource(src);
    const u1 = makeUnit({ id: 'w1', title: 'Decentralized design', summary: 'Local-first graph', body: 'Store everything locally.' });
    const u2 = makeUnit({ id: 'w2', title: 'Ingest pipeline', summary: 'Distill traces', body: 'Traces become units.' });
    const unrelated = makeUnit({ id: 'w3', title: 'No source', summary: 'ignored', body: 'no citation' });
    for (const u of [u1, u2, unrelated]) await storage.createUnit(u);
    for (const u of [u1, u2]) {
      const citation: UnitSource = { unitId: u.id, sourceId: 'src-doc', span: u.summary, assertedAt: iso() };
      await storage.addCitation(citation);
    }

    const result = await extractWiki(storage);
    expect(result.created).toBe(1);
    const page = result.assets[0];
    expect(page.kind).toBe('wiki');
    expect(page.name).toBe('docs/architecture.md');
    expect(page.sourceUnitIds.sort()).toEqual(['w1', 'w2']);
    expect(page.body).toContain('# docs/architecture.md');
    expect(page.body).toContain('Decentralized design');

    const second = await extractWiki(storage);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
  });
});

describe('service.autoPrecipitate', () => {
  it('runs layers + skills + codegraph + wiki and emits precipitate activity', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(moduleUnit({
      id: 'm1', title: 'Module: src/app.ts', summary: 'App', body: 'Path: src/app.ts\nSymbols: 0',
    }));
    await storage.createUnit(makeUnit({
      id: 'p1', type: 'procedure', title: 'Release checklist',
      summary: 'Steps to release', body: '1. Build\n2. Test\n3. Tag',
    }));
    const src: Source = {
      id: 'src-doc', uri: 'README.md', title: 'README.md',
      kind: 'file', contentHash: 'h', contentLength: 10, createdAt: iso(),
    };
    await storage.upsertSource(src);
    const w1 = makeUnit({ id: 'w1', title: 'Welcome', summary: 'Intro', body: 'Amem is local-first.' });
    await storage.createUnit(w1);
    await storage.addCitation({ unitId: 'w1', sourceId: 'src-doc', span: 'Intro', assertedAt: iso() });

    const service = await createService(testConfig(), storage);
    const result = await service.autoPrecipitate({ mode: 'fast' });
    expect(result.mode).toBe('fast');
    expect(typeof result.skillsExtracted).toBe('number');
    expect(result.codegraphCreated).toBe(1);
    expect(result.wikiCreated).toBe(1);

    const activity = await service.activity({});
    expect(activity.some((e) => e.kind === 'precipitate')).toBe(true);
  });
});

describe('auto-precipitation after ingest', () => {
  it('runs fast precipitation when enabled and new units were ingested', async () => {
    const storage = new FakeStorage();
    const cfg = testConfig();
    cfg.autoPrecipitate = { enabled: true, mode: 'fast', minIntervalMs: 0 };
    const service = await createService(cfg, storage);
    const ingested = await service.ingest({
      title: 'Auto precipitation',
      content:
        'We decided to auto-precipitate assets after every ingest. Plan: run fast mode. Procedure: call autoPrecipitate. Lesson: keep the ingest path resilient.',
    });
    expect(ingested.units.length).toBeGreaterThanOrEqual(1);

    const activity = await service.activity({});
    const precip = activity.filter((e) => e.kind === 'precipitate');
    expect(precip.length).toBeGreaterThanOrEqual(1);
    expect(precip[0].summary).toContain('Auto-precipitated');
  });

  it('does not run when disabled', async () => {
    const storage = new FakeStorage();
    const cfg = testConfig();
    cfg.autoPrecipitate = { enabled: false, mode: 'fast' };
    const service = await createService(cfg, storage);
    await service.ingest({
      title: 'No precipitation',
      content: 'Some content without automatic precipitation.',
    });

    const activity = await service.activity({});
    expect(activity.some((e) => e.kind === 'precipitate')).toBe(false);
  });

  it('respects the min-interval throttle', async () => {
    const storage = new FakeStorage();
    const cfg = testConfig();
    cfg.autoPrecipitate = { enabled: true, mode: 'fast', minIntervalMs: 3_600_000 };
    const service = await createService(cfg, storage);
    await service.ingest({ title: 'First', content: 'We decided to test throttling of precipitation.' });
    await service.ingest({ title: 'Second', content: 'We decided to keep precipitation throttled.' });

    const activity = await service.activity({});
    expect(activity.filter((e) => e.kind === 'precipitate').length).toBe(1);
  });
});
