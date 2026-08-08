import { describe, expect, it } from 'vitest';
import {
  layeredRecall,
  mergeConfig,
  createEmbedder,
  DEFAULT_EMBEDDING_DIMS,
  type AmemConfig,
  type Scenario,
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

async function seed(storage: FakeStorage, units: Unit[], persona?: { content: string; version: number }) {
  for (const u of units) await storage.createUnit(u);
  if (persona) {
    await storage.upsertPersona({
      id: 'pers_1',
      content: persona.content,
      version: persona.version,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  const scenario: Scenario = {
    id: 'scene_1',
    title: 'Deploy pipeline',
    summary: 'How releases ship',
    content: '# Deploy\nBuild, test, ship.',
    tags: ['deploy'],
    sourceUnitIds: units.map((u) => u.id),
    status: 'active',
    version: 1,
    heat: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await storage.createScenario(scenario);
}

describe('layeredRecall', () => {
  it('includes persona, matching scenario, and uncovered units', async () => {
    const storage = new FakeStorage();
    await seed(
      storage,
      [makeUnit({ id: 'u1', type: 'fact', title: 'Deploy uses Docker', tags: ['deploy'], body: 'docker compose up', status: 'reviewed' })],
      { content: 'A full-stack engineer shipping with Docker.', version: 3 },
    );
    await storage.createUnit(makeUnit({ id: 'u2', type: 'fact', title: 'React query cache invalidation', tags: ['react'], body: 'invalidate on mutation', status: 'reviewed' }));

    const result = await layeredRecall(storage, embed, cfg(), { query: 'deploy pipeline docker', tokenBudget: 2000, includeBody: true });

    expect(result.persona?.version).toBe(3);
    expect(result.scenarios.map((s) => s.scenario.title)).toContain('Deploy pipeline');
    // u1 is covered by the scenario, so it is not duplicated at L1.
    expect(result.units.map((i) => i.unit.id)).not.toContain('u1');
    expect(result.text).toContain('Persona');
    expect(result.text).toContain('Scenario: Deploy pipeline');
    expect(result.grounded).toBe(true);
    expect(result.usedTokens).toBeLessThanOrEqual(2000);
  });

  it('respects token budget and never exceeds it', async () => {
    const storage = new FakeStorage();
    const units: Unit[] = [];
    for (let i = 0; i < 40; i++) {
      units.push(makeUnit({ id: `b${i}`, type: 'fact', title: `Fact number ${i} about alpha beta`, tags: ['alpha'], body: 'content '.repeat(20), status: 'reviewed' }));
    }
    await seed(storage, units);
    const result = await layeredRecall(storage, embed, cfg(), { query: 'alpha beta facts', tokenBudget: 800 });
    expect(result.usedTokens).toBeLessThanOrEqual(800);
  });

  it('works with no persona or scenarios (plain L1 fallback)', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'solo', type: 'fact', title: 'Solo fact', body: 'detail', status: 'reviewed' }));
    const result = await layeredRecall(storage, embed, cfg(), { query: 'solo fact', tokenBudget: 1000 });
    expect(result.persona).toBeUndefined();
    expect(result.scenarios).toEqual([]);
    expect(result.units.length).toBeGreaterThanOrEqual(1);
    expect(result.grounded).toBe(true);
  });

  it('boosts hot scenarios and bumps their heat on recall hits', async () => {
    const storage = new FakeStorage();
    await seed(storage, [
      makeUnit({ id: 'u1', type: 'fact', title: 'Deploy uses Docker', tags: ['deploy'], body: 'docker compose up', status: 'reviewed' }),
    ]);
    await storage.updateScenario({
      ...(await storage.getScenario('scene_1'))!,
      heat: 40,
    });

    const result = await layeredRecall(storage, embed, cfg(), { query: 'deploy pipeline docker', tokenBudget: 2000, includeBody: true });

    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(result.scenarios[0].reason).toContain('heat');
    const bumped = await storage.getScenario('scene_1');
    expect(bumped?.heat).toBe(41);
    expect(bumped?.lastHitAt).toBeTruthy();
  });
});

void DEFAULT_EMBEDDING_DIMS;
