import { describe, expect, it } from 'vitest';
import {
  createService,
  mergeConfig,
  MockLlmClient,
  LLM_CLASSIFY_INTENT,
  type AmemConfig,
} from '../src/index.js';
import { FakeStorage, makeUnit } from './helpers.js';

function testConfig(): AmemConfig {
  return mergeConfig({
    embedding: { mode: 'offline', dims: 64 },
    jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 },
  });
}

describe('curate preset semantics', () => {
  it('fast runs consolidation only and never calls the LLM', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'u1', title: 'A random thought', labels: {} }));
    let llmCalls = 0;
    const llm = new MockLlmClient({
      [LLM_CLASSIFY_INTENT]: () => {
        llmCalls += 1;
        return { category: 'research', reason: 'test' };
      },
    });
    const service = await createService(testConfig(), storage, { llm });

    const report = await service.curate('fast');

    expect(llmCalls).toBe(0);
    expect(report.classified).toBe(0);
    expect(report.examined).toBe(0);
    const unit = await storage.getUnit('u1');
    expect(unit?.labels?.category ?? '').toBe('');
  });

  it('full LLM-classifies unclassified units and persists labels', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'u1', title: 'A random thought', labels: {} }));
    await storage.createUnit(
      makeUnit({ id: 'u2', title: 'Already classified', labels: { category: 'product' } }),
    );
    const llm = new MockLlmClient({
      [LLM_CLASSIFY_INTENT]: () => ({ category: 'research', reason: 'test' }),
    });
    const service = await createService(testConfig(), storage, { llm });

    const report = await service.curate('full');

    expect(report.examined).toBeGreaterThanOrEqual(1);
    expect(report.classified).toBeGreaterThanOrEqual(1);
    expect(report.viaLlm).toBeGreaterThanOrEqual(1);
    const classified = await storage.getUnit('u1');
    expect(classified?.labels?.category).toBe('research');
    const untouched = await storage.getUnit('u2');
    expect(untouched?.labels?.category).toBe('product');
  });

  it('full still runs consolidation and reports links/crystals', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'u1', title: 'A random thought', labels: {} }));
    const llm = new MockLlmClient({
      [LLM_CLASSIFY_INTENT]: () => ({ category: 'research', reason: 'test' }),
    });
    const service = await createService(testConfig(), storage, { llm });

    const report = await service.curate('full');

    expect(report.summary.length).toBeGreaterThan(0);
    expect(typeof report.linksCreated).toBe('number');
    expect(typeof report.archived).toBe('number');
    expect(typeof report.crystalsPromoted).toBe('number');
  });

  it('records classify statistics on the curate activity event', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'u1', title: 'A random thought', labels: {} }));
    const llm = new MockLlmClient({
      [LLM_CLASSIFY_INTENT]: () => ({ category: 'research', reason: 'test' }),
    });
    const service = await createService(testConfig(), storage, { llm });

    await service.curate('full');

    const events = storage.events.filter((e) => e.kind === 'curate');
    expect(events.length).toBe(1);
    expect(events[0].meta).toMatchObject({
      classified: expect.any(Number),
      examined: expect.any(Number),
      viaLlm: expect.any(Number),
    });
  });
});
