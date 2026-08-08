import { describe, expect, it } from 'vitest';
import {
  MockLlmClient,
  mergeConfig,
  refreshLayers,
  LLM_SCENARIO_INTENT,
  LLM_PERSONA_INTENT,
  type AmemConfig,
  type LlmClient,
} from '../src/index.js';
import { FakeStorage, makeUnit, iso } from './helpers.js';

function cfg(): AmemConfig {
  return mergeConfig({ jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 } });
}

describe('refreshLayers', () => {
  it('consolidates tagged units into an L2 scenario (heuristic fallback)', async () => {
    const storage = new FakeStorage();
    const a = makeUnit({ id: 'u1', type: 'decision', title: 'Use Vitest', tags: ['testing'], importance: 0.9, status: 'reviewed' });
    const b = makeUnit({ id: 'u2', type: 'procedure', title: 'Run tests fast', tags: ['testing'], importance: 0.7, status: 'reviewed' });
    await storage.createUnit(a);
    await storage.createUnit(b);

    const llm = new MockLlmClient({}); // no handlers -> heuristic fallback
    const result = await refreshLayers(llm, storage, cfg());

    expect(result.scenariosCreated).toBe(1);
    expect(result.personaUpdated).toBe(true);
    const scenarios = await storage.listScenarios({});
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].tags).toContain('testing');
    expect(scenarios[0].sourceUnitIds).toEqual(expect.arrayContaining(['u1', 'u2']));
    const persona = await storage.getPersona();
    expect(persona).not.toBeNull();
    expect(persona!.content.length).toBeLessThanOrEqual(2000);
  });

  it('uses LLM JSON drafts when the model responds, and updates existing scenarios', async () => {
    const storage = new FakeStorage();
    const a = makeUnit({ id: 'u1', type: 'lesson', title: 'Keep commits small', tags: ['git'], status: 'reviewed' });
    const seed = makeUnit({ id: 'u0', type: 'fact', title: 'Always rebase before merge', tags: ['git'], status: 'reviewed' });
    await storage.createUnit(a);
    await storage.createUnit(seed);
    const llm = new MockLlmClient({
      [LLM_SCENARIO_INTENT]: () => ({ title: 'Git hygiene', summary: 'Small commits', content: '# Git hygiene\n- keep commits small' }),
      [LLM_PERSONA_INTENT]: () => ({ content: 'A careful engineer who values clean history.' }),
    });

    const first = await refreshLayers(llm, storage, cfg(), { forcePersona: true });
    expect(first.scenariosCreated).toBe(1);

    // Re-run: update the existing scenario (integration path).
    const b = makeUnit({ id: 'u2', type: 'fact', title: 'Rebase before merge', tags: ['git'], status: 'reviewed' });
    await storage.createUnit(b);
    const second = await refreshLayers(llm, storage, cfg());
    expect(second.scenariosCreated).toBe(0);
    expect(second.scenariosUpdated).toBe(1);
    const scenarios = await storage.listScenarios({});
    expect(scenarios[0].version).toBe(2);
    expect(scenarios[0].sourceUnitIds).toEqual(expect.arrayContaining(['u0', 'u1', 'u2']));
  });

  it('never throws when the LLM fails (offline safe)', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'x', type: 'fact', title: 'Alpha', tags: ['a', 'b'], status: 'reviewed' }));
    await storage.createUnit(makeUnit({ id: 'y', type: 'fact', title: 'Beta', tags: ['a'], status: 'reviewed' }));
    const throwing = {
      complete: async () => { throw new Error('boom'); },
      completeJSON: async () => { throw new Error('boom'); },
    } as unknown as InstanceType<typeof MockLlmClient>;
    const result = await refreshLayers(throwing, storage, cfg());
    expect(result.scenariosCreated).toBeGreaterThanOrEqual(0);
    expect(typeof result.personaUpdated).toBe('boolean');
  });

  it('scenario version tracks updates with timestamps', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'u1', type: 'fact', title: 'One', tags: ['t'], updatedAt: iso(), status: 'reviewed' }));
    await storage.createUnit(makeUnit({ id: 'u2', type: 'fact', title: 'Two', tags: ['t'], updatedAt: iso(), status: 'reviewed' }));
    const llm = new MockLlmClient({});
    await refreshLayers(llm, storage, cfg());
    const s1 = (await storage.listScenarios({}))[0];
    expect(s1.lastConsolidatedAt).toBeTruthy();
    expect(new Date(s1.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('fast mode makes zero LLM calls (deterministic heuristics)', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'u1', type: 'decision', title: 'Use Vitest', tags: ['testing'], importance: 0.9, status: 'reviewed' }));
    await storage.createUnit(makeUnit({ id: 'u2', type: 'procedure', title: 'Run tests fast', tags: ['testing'], importance: 0.7, status: 'reviewed' }));
    await storage.createUnit(makeUnit({ id: 'u3', type: 'lesson', title: 'Keep tests green', tags: ['testing'], importance: 0.6, status: 'reviewed' }));
    let calls = 0;
    const counting: LlmClient = {
      complete: async () => { calls++; return ''; },
      completeJSON: async () => { calls++; return { title: 'X', summary: 'Y', content: 'Z' }; },
    };

    const result = await refreshLayers(counting, storage, cfg(), { mode: 'fast', forcePersona: true });

    expect(calls).toBe(0);
    expect(result.scenariosCreated).toBe(1);
    expect(result.personaUpdated).toBe(true);
  });

  it('auto mode calls the LLM only for large groups and keeps persona heuristic', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 's1', type: 'fact', title: 'Small one', tags: ['small'], status: 'reviewed' }));
    await storage.createUnit(makeUnit({ id: 's2', type: 'fact', title: 'Small two', tags: ['small'], status: 'reviewed' }));
    for (let i = 0; i < 5; i++) {
      await storage.createUnit(makeUnit({ id: `b${i}`, type: 'fact', title: `Big ${i}`, tags: ['big'], status: 'reviewed' }));
    }
    let scenarioCalls = 0;
    let personaCalls = 0;
    const counting: LlmClient = {
      complete: async () => { personaCalls++; return ''; },
      completeJSON: async () => {
        scenarioCalls++;
        return { title: 'LLM scenario', summary: 'sum', content: 'body' };
      },
    };

    const result = await refreshLayers(counting, storage, cfg(), { mode: 'auto', forcePersona: true });

    expect(scenarioCalls).toBe(1); // only the 5-unit group
    expect(personaCalls).toBe(0);
    expect(result.scenariosCreated).toBe(2);
    const scenarios = await storage.listScenarios({});
    const big = scenarios.find((s) => s.tags.includes('big'));
    const small = scenarios.find((s) => s.tags.includes('small'));
    expect(big?.title).toBe('LLM scenario');
    expect(small?.title).toBe('small');
  });

  it('full mode calls the LLM for every group and the persona', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(makeUnit({ id: 'a', type: 'fact', title: 'Alpha', tags: ['t'], status: 'reviewed' }));
    await storage.createUnit(makeUnit({ id: 'b', type: 'fact', title: 'Beta', tags: ['t'], status: 'reviewed' }));
    let scenarioCalls = 0;
    let personaCalls = 0;
    const counting: LlmClient = {
      complete: async () => { personaCalls++; return ''; },
      completeJSON: async (prompt) => {
        if (prompt.includes(LLM_PERSONA_INTENT)) personaCalls++;
        else scenarioCalls++;
        return { title: 'LLM title', summary: 'sum', content: 'body' };
      },
    };

    const result = await refreshLayers(counting, storage, cfg(), { mode: 'full', forcePersona: true });

    expect(scenarioCalls).toBe(1);
    expect(personaCalls).toBe(1);
    expect(result.scenariosCreated).toBe(1);
  });
});
