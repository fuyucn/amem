import { describe, expect, it } from 'vitest';
import {
  createService,
  mergeConfig,
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

describe('reembedAll', () => {
  it('recomputes embeddings for every unit', async () => {
    const storage = new FakeStorage();
    const units: Unit[] = [
      makeUnit({
        id: 'u1',
        title: 'Deploy uses docker compose',
        body: 'docker compose up -d',
        embedding: { dims: 64, values: new Array(64).fill(0.1) },
      }),
      makeUnit({
        id: 'u2',
        title: 'Rotate db credentials',
        body: 'rotate the database password quarterly',
        embedding: { dims: 64, values: new Array(64).fill(-0.1) },
      }),
    ];
    for (const u of units) await storage.createUnit(u);

    const service = await createService(cfg(), storage);
    const result = await service.reembedAll();

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.mode).toBe('offline');

    const after = (await storage.getUnit('u1'))!;
    expect(after.embedding!.dims).toBe(64);
    // The stale constant vector must be gone (real per-text vector now).
    expect(after.embedding!.values.some((x) => x > 0.5 || x < -0.5)).toBe(true);
  });

  it('dryRun does not write', async () => {
    const storage = new FakeStorage();
    const u = makeUnit({
      id: 'u1',
      title: 'Keep this title',
      embedding: { dims: 64, values: new Array(64).fill(0.25) },
    });
    await storage.createUnit(u);

    const service = await createService(cfg(), storage);
    const result = await service.reembedAll({ dryRun: true });
    expect(result.updated).toBe(1);
    const after = (await storage.getUnit('u1'))!;
    expect(after.embedding!.values.every((x) => Math.abs(x - 0.25) < 1e-9)).toBe(true);
  });
});
