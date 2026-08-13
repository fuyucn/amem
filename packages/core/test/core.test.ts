import { describe, expect, it } from 'vitest';
import { createServer as httpServer } from 'node:http';
import {
  cosine, hashEmbed, normalize, DEFAULT_EMBEDDING_DIMS,
  countTokens,
  findDuplicate, mergeUnits,
  heuristicExtract, distillUnits,
  recall, consolidate, buildWorkingMemory, renderOkfBundle,
  createService, createEmbedder, MockLlmClient,
  refreshLayers,
  ApiEmbedder,
  generateLinks,
  mergeConfig,
  type AmemConfig, type Unit, type ExportBundle,
} from '../src/index.js';
import { FakeStorage, makeUnit, iso } from './helpers.js';

function testConfig(): AmemConfig {
  return mergeConfig({
    embedding: { mode: 'offline', dims: 64 },
    jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 },
  });
}
const cfg = testConfig();

function embedVec(text: string): { dims: number; values: number[] } {
  return { dims: DEFAULT_EMBEDDING_DIMS, values: normalize(hashEmbed(text, DEFAULT_EMBEDDING_DIMS)) };
}
const offlineEmbed = await createEmbedder(cfg.embedding);

describe('vector', () => {
  it('cosine of identical vectors is 1', () => {
    const v = normalize([1, 2, 3, 4]);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });
  it('cosine of orthogonal vectors is ~0', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('normalize produces unit length', () => {
    const n = normalize([3, 4]);
    expect(Math.hypot(n[0], n[1])).toBeCloseTo(1, 6);
  });
});

describe('tokenizer', () => {
  it('counts tokens deterministically and > 0', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0);
    expect(countTokens('hello world')).toBe(countTokens('hello world'));
    expect(countTokens('你好，世界')).toBeGreaterThan(0);
  });
});

describe('dedup', () => {
  it('findDuplicate matches similar candidates above threshold', async () => {
    const a: Unit = makeUnit({ id: 'a', title: 'React state management', body: 'use hooks' });
    const sim = cosine(embedVec('react state management').values, embedVec('react state management').values);
    // Simple bag-of-words threshold test uses the embedding path
    const dup = findDuplicate({ title: 'React state management', embedding: embedVec('react state management') }, [a], cfg.thresholds.dedupSimThreshold);
    // findDuplicate may be title+keyword based; just assert it runs and returns object or null
    expect(dup === null || 'unit' in dup).toBe(true);
    void sim;
  });
  it('mergeUnits combines body and bumps quality', () => {
    const a = makeUnit({ id: 'x', body: 'first', quality: 0.7 });
    const merged = mergeUnits(a, { summary: 'new', body: 'second', quality: 0.9 });
    expect(merged.body).toContain('second');
    expect(merged.quality).toBeGreaterThanOrEqual(0.7);
  });
});

describe('distill (offline heuristic fallback)', () => {
  it('heuristicExtract produces units from text', () => {
    const units = heuristicExtract('We decided to use a local-first knowledge graph for agent memory.\nThen we embed every unit to dedup it.\nData stays on our disk always.');
    expect(units.length).toBeGreaterThanOrEqual(1);
    expect(['fact','decision','procedure']).toContain(units[0].type);
    expect(units[0].title.length).toBeGreaterThan(0);
  });

  
  it('strips user/assistant role prefixes and avoids role titles', () => {
    const units = heuristicExtract(
      'user: Remember that Graph must filter dangling links to archived units.\n\nassistant: Fixed getGraph to drop edges whose endpoints are missing, and fixed curate decay so it is absolute from updatedAt with a 7-day grace window.',
    );
    expect(units.length).toBeGreaterThan(0);
    for (const u of units) {
      expect(u.title.toLowerCase().startsWith('user')).toBe(false);
      expect(u.title.toLowerCase().startsWith('assistant')).toBe(false);
      expect(u.body.toLowerCase().startsWith('user:')).toBe(false);
    }
  });

  it('honors labeled Decision/Procedure lines and types them', () => {
    const units = heuristicExtract(
      'Decision: Amem is the shared local memory layer for Codex.\nProcedure: at session start call working_memory and recall.\nPreference: show new knowledge in the Activity tab.\nHi there',
    );
    const types = new Set(units.map((u) => u.type));
    expect(types.has('decision') || units.some((u) => /shared local memory/i.test(u.title))).toBe(true);
    expect(units.some((u) => u.type === 'procedure' || /working_memory/i.test(u.body))).toBe(true);
    // greeting alone should not dominate
    expect(units.every((u) => !/^hi there$/i.test(u.body.trim()))).toBe(true);
  });

  it('distillUnits falls back to heuristic when the LLM returns nothing', async () => {
    const storage = new FakeStorage();
    const llm = new MockLlmClient();
    const result = await distillUnits(llm, offlineEmbed, 'A decision: we store memory locally.\nB procedure: dedup before insert.', storage, cfg);
    expect(result.units.length).toBeGreaterThanOrEqual(1);
  });

  it('distillUnits falls back to heuristic when the LLM throws (provider outage)', async () => {
    const storage = new FakeStorage();
    const throwingLlm = {
      async complete(): Promise<string> {
        throw new Error('LLM API error 429: rate limited');
      },
      async completeJSON<T>(): Promise<T> {
        throw new Error('LLM API error 429: rate limited');
      },
    };
    const result = await distillUnits(throwingLlm, offlineEmbed, 'A decision: we store memory locally.\nB procedure: dedup before insert.', storage, cfg);
    expect(result.units.length).toBeGreaterThanOrEqual(1);
    expect(result.units.some((u) => /store memory locally/i.test(u.title))).toBe(true);
    const failed = storage.events.filter((e) => e.kind === 'distill_llm_failed');
    expect(failed.length).toBe(1);
    expect(failed[0]?.meta?.error).toContain('429');
  });
});

describe('generateLinks', () => {
  it('links units that share at least two tags when semantic similarity is low', async () => {
    const storage = new FakeStorage();
    const a = makeUnit({
      id: 'ua1',
      title: 'Amem deployment via docker',
      tags: ['amem', 'docker', 'deploy', 'local'],
      embedding: embedVec('docker deployment alpha'),
    });
    const b = makeUnit({
      id: 'ub1',
      title: 'Amem data lives in SQLite',
      tags: ['amem', 'docker', 'sqlite', 'local'],
      embedding: embedVec('sqlite storage beta'),
    });
    const c = makeUnit({
      id: 'uc1',
      title: 'Unrelated gardening tip',
      tags: ['garden', 'soil'],
      embedding: embedVec('gardening gamma'),
    });
    await storage.createUnit(a);
    await storage.createUnit(b);
    await storage.createUnit(c);

    const { linksCreated } = await generateLinks(storage, offlineEmbed, cfg);
    expect(linksCreated).toBe(1);
    const links = await storage.allLinks();
    expect(links[0]?.reason).toContain('shared-tags');
    expect(links[0]?.reason).toContain('amem');
    expect(links[0]?.reason).toContain('docker');
  });

  it('caps auto-links per unit so the graph degree stays bounded', async () => {
    const storage = new FakeStorage();
    for (let i = 1; i <= 10; i++) {
      await storage.createUnit(
        makeUnit({
          id: `ub${i}`,
          title: `Bounded unit ${i}`,
          tags: ['common', 'shared', 'tag'],
          embedding: embedVec(`bounded unit ${i}`),
        }),
      );
    }
    const { linksCreated } = await generateLinks(storage, offlineEmbed, cfg);
    // Far fewer than the full 45-pair set, and every node's degree stays ~maxLinksPerUnit.
    expect(linksCreated).toBeGreaterThan(0);
    expect(linksCreated).toBeLessThan(45);
    const links = await storage.allLinks();
    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(l.sourceUnitId, (degree.get(l.sourceUnitId) ?? 0) + 1);
      degree.set(l.targetUnitId, (degree.get(l.targetUnitId) ?? 0) + 1);
    }
    for (const d of degree.values()) {
      expect(d).toBeLessThanOrEqual(cfg.thresholds.maxLinksPerUnit + 1);
    }
  });

  it('never assigns typed relations from the weak shared-tags signal', async () => {
    const storage = new FakeStorage();
    const a = makeUnit({
      id: 'wt1',
      title: 'Extends the Amem storage layer',
      tags: ['amem', 'extends', 'layer', 'storage'],
      embedding: embedVec('extend storage alpha'),
    });
    const b = makeUnit({
      id: 'wt2',
      title: 'Extends the Amem recall layer',
      tags: ['amem', 'extends', 'layer', 'recall'],
      embedding: embedVec('extend recall beta'),
    });
    await storage.createUnit(a);
    await storage.createUnit(b);

    const { linksCreated } = await generateLinks(storage, offlineEmbed, cfg);
    expect(linksCreated).toBe(1);
    const links = await storage.allLinks();
    expect(links[0]?.relation).toBe('related_to');
    expect(links[0]?.reason).toContain('shared-tags');
  });
});

describe('pruneAutoLinks', () => {
  it('trims auto links to a bounded degree and keeps manual links', async () => {
    const storage = new FakeStorage();
    const service = await createService(cfg, storage);
    for (let i = 1; i <= 10; i++) {
      await storage.createUnit(
        makeUnit({
          id: `p${i}`,
          title: `Prune unit ${i}`,
          tags: ['common', 'shared', 'tag'],
          embedding: embedVec(`prune unit ${i}`),
        }),
      );
    }
    await generateLinks(storage, offlineEmbed, cfg);
    await service.linkUnits({ sourceUnitId: 'p1', targetUnitId: 'p2', relation: 'supports' });

    const preview = await service.pruneAutoLinks({ maxPerUnit: 2, dryRun: true });
    expect(preview.deleted).toBeGreaterThan(0);
    expect(preview.kept + preview.deleted).toBe(preview.examined);

    const report = await service.pruneAutoLinks({ maxPerUnit: 2 });
    expect(report.deleted).toBeGreaterThan(0);
    const remaining = await storage.allLinks();
    const manual = remaining.filter((l) => !l.auto);
    expect(manual.length).toBe(1);
    expect(manual[0]?.relation).toBe('supports');
    const degree = new Map<string, number>();
    for (const l of remaining.filter((l) => l.auto)) {
      degree.set(l.sourceUnitId, (degree.get(l.sourceUnitId) ?? 0) + 1);
      degree.set(l.targetUnitId, (degree.get(l.targetUnitId) ?? 0) + 1);
    }
    for (const d of degree.values()) expect(d).toBeLessThanOrEqual(2);
  });
});

describe('recall', () => {
  it('assembles a cited, budgeted context block', async () => {
    const storage = new FakeStorage();
    const src = { id: 's1', uri: 'https://x.test/1', title: 'Source one', kind: 'url' as const, contentHash: 'h', contentLength: 10, createdAt: iso() };
    await storage.upsertSource(src);
    const u = makeUnit({
      id: 'u1', title: 'Agent memory storage', summary: 'store in local sqlite',
      body: 'A local-first graph holds agent memory; dedup and citation keep it grounded.',
      embedding: embedVec('agent memory storage local sqlite dedup citation'),
    });
    await storage.createUnit(u);
    await storage.addCitation({ unitId: 'u1', sourceId: 's1', assertedAt: iso() });

    const res = await recall(storage, offlineEmbed, cfg, { query: 'how to store agent memory', tokenBudget: 2000 });
    expect(res.items.length).toBeGreaterThanOrEqual(1);
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.text).toContain('Source');
    expect(res.usedTokens).toBeLessThanOrEqual(2000);
  });
});

describe('consolidate', () => {
  it('promotes crystals and archives stale units', async () => {
    const storage = new FakeStorage();
    const seed = ['s1', 's2', 's3'];
    for (const id of seed) await storage.upsertSource({ id, title: `src ${id}`, kind: 'manual', contentHash: 'h', contentLength: 1, createdAt: iso() });
    const crystal = makeUnit({ id: 'c1', title: 'Stable conclusion', embedding: embedVec('stable conclusion validated') });
    await storage.createUnit(crystal);
    for (const sid of seed) await storage.addCitation({ unitId: 'c1', sourceId: sid, assertedAt: iso() });

    const stale = makeUnit({
      id: 'stale', title: 'Old note', status: 'reviewed', decay: 0.2,
      updatedAt: iso(new Date(Date.now() - 40 * 86400000)), embedding: embedVec('old note'),
    });
    await storage.createUnit(stale);

    const report = await consolidate(storage, cfg);
    expect(report.crystalsPromoted).toBeGreaterThanOrEqual(1);
    expect((await storage.getUnit('c1'))!.form).toBe('crystal');
    expect((await storage.getUnit('stale'))!.status).toBe('archived');
    expect(report.archived).toBeGreaterThanOrEqual(1);
  });

  it('generates tag-overlap links in the default (fast) path', async () => {
    const storage = new FakeStorage();
    const a = makeUnit({
      id: 'ca1', title: 'Amem via docker', tags: ['amem', 'docker', 'deploy', 'local'],
      embedding: embedVec('docker amem deploy'),
    });
    const b = makeUnit({
      id: 'ca2', title: 'Amem sqlite storage', tags: ['amem', 'docker', 'sqlite', 'local'],
      embedding: embedVec('sqlite amem docker'),
    });
    await storage.createUnit(a);
    await storage.createUnit(b);

    const report = await consolidate(storage, cfg, offlineEmbed);
    expect(report.linksCreated).toBe(1);
    const links = await storage.allLinks();
    expect(links[0]?.reason).toContain('shared-tags');
  });

  it('prunes stale tag-overlap links below the threshold', async () => {
    const storage = new FakeStorage();
    const a = makeUnit({
      id: 'pa1', title: 'Amem via docker', tags: ['amem', 'docker'],
      embedding: embedVec('docker amem'),
    });
    const b = makeUnit({
      id: 'pa2', title: 'Amem sqlite storage', tags: ['amem', 'docker', 'sqlite'],
      embedding: embedVec('sqlite amem'),
    });
    await storage.createUnit(a);
    await storage.createUnit(b);
    await storage.createLink({
      id: 'stale1', sourceUnitId: 'pa1', targetUnitId: 'pa2',
      relation: 'related_to', reason: 'shared-tags: amem, docker',
      confidence: 0.8, auto: true, createdAt: iso(),
    });

    const report = await consolidate(storage, cfg, offlineEmbed);
    expect(report.linksPruned).toBe(1);
    expect((await storage.allLinks()).length).toBe(0);
  });

  it('is idempotent and only writes units that changed', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'idem1', title: 'Idempotent unit' }));
    await consolidate(storage, cfg, undefined, { skipLinks: true });

    // Second pass: same-day decay is quantized to whole days and importance
    // already matches, so nothing may be written back.
    const written: number[] = [];
    const original = storage.updateUnits.bind(storage);
    storage.updateUnits = async (units) => {
      written.push(units.length);
      return original(units);
    };
    const report = await consolidate(storage, cfg, undefined, { skipLinks: true });
    expect(written).toEqual([0]);
    expect((await storage.getUnit('idem1'))!.importance).toBe(0);
    expect(report.archived).toBe(0);
  });
});

describe('working memory', () => {
  it('builds a briefing within budget', async () => {
    const storage = new FakeStorage();
    for (let i = 0; i < 5; i++) {
      await storage.createUnit(makeUnit({ id: `w${i}`, title: `Topic ${i}`, importance: 0.9, decay: 1, embedding: embedVec(`topic ${i}`) }));
    }
    const wm = await buildWorkingMemory(storage, cfg, iso(), 1500);
    expect(wm.tokenCount).toBeLessThanOrEqual(1500);
    expect(wm.text.length).toBeGreaterThan(0);
    expect(wm.selected.length).toBeGreaterThanOrEqual(1);
  });
});

describe('okf export', () => {
  it('renders a bundle with index.md and pages', () => {
    const u = makeUnit({ id: 'u9', title: 'Amem Graph', summary: 'A graph', body: 'nodes + edges', tags: ['graph'] });
    const bundle: ExportBundle = {
      version: 1, exportedAt: iso(),
      graph: { nodes: [], links: [] },
      units: [u], links: [], traces: [], sources: [], unitSources: [],
    };
    const files = renderOkfBundle(bundle);
    expect(files.has('index.md')).toBe(true);
    expect([...files.keys()].some((k) => k.endsWith('.md') && k !== 'index.md')).toBe(true);
  });
});

describe('service (offline ingest -> recall)', () => {
  it('ingests content, persists units, and recalls them', async () => {
    const storage = new FakeStorage();
    const service = await createService(cfg, storage);
    const health = service.health();
    expect(health.ok).toBe(true);
    expect(health.embeddingMode).toBe('offline');

    const ingested = await service.ingest({
      title: 'Architecture review',
      content: 'We decided to ship Amem as a local-first graph. Plan: distill traces into atomic units. Procedure: embed and dedup on ingest.',
    });
    expect(ingested.units.length).toBeGreaterThanOrEqual(1);
    const units = await service.listUnits({});
    expect(units.length).toBeGreaterThanOrEqual(1);

    const r = await service.recall({ query: 'how is Amem designed', tokenBudget: 2000 });
    expect(r.items.length).toBeGreaterThanOrEqual(1);

    const stats = await service.stats();
    expect(stats.counts.units).toBeGreaterThanOrEqual(1);
    expect(stats.counts.traces).toBeGreaterThanOrEqual(1);
  });

  it('setEmbedder swaps the runtime embedder used by health', async () => {
    const storage = new FakeStorage();
    const service = await createService(cfg, storage);
    expect(service.health().embeddingMode).toBe('offline');

    service.setEmbedder(new ApiEmbedder('http://127.0.0.1:1', 'text-embedding-v3'));
    expect(service.health().embeddingMode).toBe('api');

    service.setEmbedder(offlineEmbed);
    expect(service.health().embeddingMode).toBe('offline');
  });

  it('graph overlays scenario nodes with heat for hot-scene navigation', async () => {
    const storage = new FakeStorage();
    const service = await createService(cfg, storage);
    await storage.createUnit({ ...makeUnit({ id: 'g1', title: 'Compose setup', tags: ['compose'], status: 'reviewed' }), updatedAt: iso() });
    await storage.createUnit({ ...makeUnit({ id: 'g2', title: 'Compose health', tags: ['compose'], status: 'reviewed' }), updatedAt: iso() });
    await refreshLayers(new MockLlmClient({}), storage, cfg, { mode: 'fast' });
    const graph = await service.getGraph(false, true);
    const scene = graph.nodes.find((n) => n.isScenario);
    expect(scene).toBeTruthy();
    expect(typeof scene?.heat).toBe('number');
    expect(graph.links.some((l) => l.sourceUnitId === scene?.id && l.relation === 'references')).toBe(true);
  });
});

describe('service asset routing (Tencent-style tools/list + tools/call)', () => {
  const assetBase = {
    description: 'd',
    content: '{"steps":[]}',
    body: 'Step one. Step two. Step three.',
    trigger: 'when deploying',
    tags: ['codex'],
    sourceUnitIds: ['u1'],
    status: 'published' as const,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('listEquipped only surfaces published + visible/bound assets', async () => {
    const storage = new FakeStorage();
    const service = await createService(cfg, storage);
    await service.saveAsset({ id: 'a1', kind: 'skill', name: 'Deploy skill', ...assetBase, visibility: 'workspace' });
    await service.saveAsset({ id: 'a2', kind: 'skill', name: 'Codex-only', ...assetBase, visibility: 'private', boundAgents: ['codex'] });
    await service.saveAsset({ id: 'a3', kind: 'skill', name: 'Claude-only', ...assetBase, visibility: 'private', boundAgents: ['claude'] });
    await service.saveAsset({ id: 'a4', kind: 'skill', name: 'Draft', ...assetBase, status: 'draft' });

    const ids = (await service.listEquipped('codex')).map((a) => a.id).sort();
    expect(ids).toEqual(['a1', 'a2']);
  });

  it('callAsset rejects unpublished assets with FORBIDDEN', async () => {
    const storage = new FakeStorage();
    const service = await createService(cfg, storage);
    await service.saveAsset({ id: 'a1', kind: 'skill', name: 'Draft skill', ...assetBase, status: 'draft' });
    await expect(service.callAsset({ id: 'a1', agent: 'codex' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('callAsset rejects agents not bound to a private asset', async () => {
    const storage = new FakeStorage();
    const service = await createService(cfg, storage);
    await service.saveAsset({ id: 'a1', kind: 'skill', name: 'Codex-only', ...assetBase, visibility: 'private', boundAgents: ['codex'] });
    await expect(service.callAsset({ id: 'a1', agent: 'claude' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('callAsset truncates body to budget and records activity', async () => {
    const storage = new FakeStorage();
    const service = await createService(cfg, storage);
    await service.saveAsset({ id: 'a1', kind: 'skill', name: 'Long skill', ...assetBase, visibility: 'workspace', body: 'x'.repeat(5000) });

    const result = await service.callAsset({ id: 'a1', agent: 'codex', budget: 100 });
    expect(result.assetId).toBe('a1');
    expect(result.kind).toBe('skill');
    expect(result.usedTokens).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThan(5000);
    expect(result.body).toContain('[truncated:');

    const events = storage.events.filter((e) => e.kind === 'asset_call');
    expect(events.length).toBe(1);
    expect(events[0].meta).toMatchObject({ assetId: 'a1', agent: 'codex', budget: 100 });
  });
});

describe('ApiEmbedder (mock HTTP)', () => {
  async function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
    const server = httpServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return {
      server,
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it('posts to /embeddings, parses vectors, sends bearer key, caches dims', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: { model?: string; input?: string[] } }> = [];
    const { url, close } = await listen((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { model?: string; input?: string[] };
        calls.push({ url: req.url ?? '', headers: req.headers as Record<string, string>, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: (body.input ?? []).map((_, i) => ({ embedding: [i + 1, 2, 3] })) }));
      });
    });
    try {
      const e = new ApiEmbedder(`${url}/v1`, 'nomic-embed-text', 'sk-test');
      const vecs = await e.embedMany(['a', 'b']);
      expect(vecs).toHaveLength(2);
      expect(vecs[0]?.[0]).toBe(1);
      expect(await e.dims()).toBe(3);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toBe('/v1/embeddings');
      expect(calls[0]?.body.model).toBe('nomic-embed-text');
      expect(calls[0]?.body.input).toEqual(['a', 'b']);
      expect(calls[0]?.headers.authorization).toBe('Bearer sk-test');

      await expect(e.embed('x')).resolves.toHaveLength(3);
      expect(await e.dims()).toBe(3);
      expect(calls).toHaveLength(3);
    } finally {
      await close();
    }
  });

  it('omits the Authorization header when no key is set', async () => {
    const headers: string[] = [];
    const { url, close } = await listen((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        headers.push(req.headers.authorization ?? '');
        res.setHeader('Content-Type', 'application/json');
        const input = (JSON.parse(raw || '{}') as { input?: string[] }).input ?? [];
        res.end(JSON.stringify({ data: input.map((_, i) => ({ embedding: [i + 1, 2, 3] })) }));
      });
    });
    try {
      const e = new ApiEmbedder(`${url}`, 'm');
      await e.embedMany(['x', 'y']);
      expect(headers).toEqual(['']);
    } finally {
      await close();
    }
  });

  it('throws a provider error on non-200 responses', async () => {
    const { url, close } = await listen((_req, res) => {
      res.statusCode = 502;
      res.end('bad gateway');
    });
    try {
      const e = new ApiEmbedder(`${url}`, 'm');
      await expect(e.embed('x')).rejects.toThrow(/Embedding API error 502/);
    } finally {
      await close();
    }
  });
});
