import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBEDDING_DIMS,
  createEmbedder,
  cosine,
  hashEmbed,
  layeredRecall,
  mergeConfig,
  normalize,
  recall,
  type AmemConfig,
  type Unit,
} from '../src/index.js';
import { FakeStorage, makeUnit } from './helpers.js';

function cfg(): AmemConfig {
  return mergeConfig({
    embedding: { mode: 'offline', dims: 64 },
    jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 },
  });
}

const embed = await createEmbedder(cfg().embedding);

function embedVec(text: string): { dims: number; values: number[] } {
  return { dims: DEFAULT_EMBEDDING_DIMS, values: normalize(hashEmbed(text, DEFAULT_EMBEDDING_DIMS)) };
}

describe('recall quality: near-duplicate suppression', () => {
  it('keeps one canonical block when titles normalize identically', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(
      makeUnit({
        id: 'u1',
        title: 'Deploy uses Docker',
        body: 'docker compose up -d',
        embedding: embedVec('deploy uses docker'),
        status: 'reviewed',
      }),
    );
    await storage.createUnit(
      makeUnit({
        id: 'u2',
        title: 'deploy uses docker!',
        body: 'docker compose up -d again',
        embedding: embedVec('deploy uses docker'),
        status: 'reviewed',
      }),
    );

    const out = await recall(storage, embed, cfg(), {
      query: 'deploy docker',
      tokenBudget: 4000,
      topK: 10,
      includeBody: true,
    });

    expect(out.items).toHaveLength(1);
    expect(out.deduplicated).toBeGreaterThanOrEqual(1);
    expect(['u1', 'u2']).toContain(out.items[0]!.unit.id);
  });

  it('suppresses embedding near-duplicates even when titles differ', async () => {
    const storage = new FakeStorage();
    const a = embedVec('deploy uses docker compose');
    const b = { dims: a.dims, values: [...a.values] };
    // Different title wording with a near-identical embedding (what a
    // paraphrase looks like after embedding): must be suppressed.
    expect(cosine(a.values, b.values)).toBeGreaterThanOrEqual(0.92);
    await storage.createUnit(
      makeUnit({ id: 'u1', title: 'Deploy uses docker compose', embedding: a, status: 'reviewed' }),
    );
    await storage.createUnit(
      makeUnit({ id: 'u2', title: 'Compose docker deployment instructions', embedding: b, status: 'reviewed' }),
    );

    const out = await recall(storage, embed, cfg(), {
      query: 'deploy docker compose',
      tokenBudget: 4000,
      topK: 10,
    });

    expect(out.items).toHaveLength(1);
    expect(out.deduplicated).toBeGreaterThanOrEqual(1);
  });

  it('layeredRecall applies the same suppression at L1', async () => {
    const storage = new FakeStorage();
    const a = embedVec('rotate db credentials');
    await storage.createUnit(
      makeUnit({ id: 'u1', title: 'Rotate DB credentials', embedding: a, status: 'reviewed' }),
    );
    await storage.createUnit(
      makeUnit({
        id: 'u2',
        title: 'Database credential rotation procedure',
        embedding: { dims: a.dims, values: [...a.values] },
        status: 'reviewed',
      }),
    );

    const out = await layeredRecall(storage, embed, cfg(), {
      query: 'rotate db credentials',
      tokenBudget: 4000,
      topK: 10,
    });

    expect(out.units).toHaveLength(1);
    expect(out.deduplicated).toBeGreaterThanOrEqual(1);
  });
});

describe('recall quality: pending demotion', () => {
  it('ranks reviewed knowledge above unreviewed extraction for the same query', async () => {
    const storage = new FakeStorage();
    const reviewed: Unit = makeUnit({
      id: 'u_reviewed',
      title: 'Deploy amem via docker',
      body: 'docker compose up -d',
      embedding: embedVec('deploy amem via docker'),
      status: 'reviewed',
    });
    const pending: Unit = makeUnit({
      id: 'u_pending',
      title: 'Docker deployment notes',
      body: 'docker compose down',
      embedding: embedVec('docker deployment notes'),
      status: 'pending',
    });
    await storage.createUnit(reviewed);
    await storage.createUnit(pending);

    const out = await recall(storage, embed, cfg(), {
      query: 'deploy docker',
      tokenBudget: 4000,
      topK: 10,
    });

    expect(out.items.map((i) => i.unit.id)).toContain('u_reviewed');
    expect(out.items.map((i) => i.unit.id)).toContain('u_pending');
    const reviewedItem = out.items.find((i) => i.unit.id === 'u_reviewed')!;
    const pendingItem = out.items.find((i) => i.unit.id === 'u_pending')!;
    expect(pendingItem.reason).toContain('pending');
    expect(pendingItem.score).toBeLessThan(reviewedItem.score);
    expect(out.items[0]!.unit.id).toBe('u_reviewed');
  });
});
