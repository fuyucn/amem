import { describe, expect, it } from 'vitest';
import {
  LLM_CLASSIFY_INTENT,
  MockLlmClient,
  classifyUnitRuleBased,
  classifyUnits,
  type Unit,
} from '../src/index.js';
import { makeUnit } from './helpers.js';

function unit(over: Partial<Unit>): Unit {
  return makeUnit({ ...over });
}

describe('classifyUnitRuleBased', () => {
  it('classifies code symbols via labels first', () => {
    expect(classifyUnitRuleBased(unit({ title: 'queryTerms', labels: { symbolKind: 'function' } }))).toBe('code');
    expect(classifyUnitRuleBased(unit({ title: 'Anything', labels: { kind: 'module' } }))).toBe('code');
  });

  it('classifies code-prefixed titles', () => {
    expect(classifyUnitRuleBased(unit({ title: 'function: queryTerms — layeredRecall.ts' }))).toBe('code');
    expect(classifyUnitRuleBased(unit({ title: 'interface ImportSessionsInput — domain.ts' }))).toBe('code');
  });

  it('maps explicit unit types onto the taxonomy', () => {
    expect(classifyUnitRuleBased(unit({ type: 'procedure', title: 'Run tests' }))).toBe('workflow');
    expect(classifyUnitRuleBased(unit({ type: 'preference', title: 'Prefer pnpm' }))).toBe('personal');
    expect(classifyUnitRuleBased(unit({ type: 'question', title: 'Why?' }))).toBe('research');
    expect(classifyUnitRuleBased(unit({ type: 'lesson', title: 'Learned' }))).toBe('research');
    expect(classifyUnitRuleBased(unit({ type: 'decision', title: 'Use Vitest' }))).toBe('product');
    expect(classifyUnitRuleBased(unit({ type: 'plan', title: 'Roadmap' }))).toBe('product');
  });

  it('falls back to keyword signals', () => {
    expect(classifyUnitRuleBased(unit({ title: 'Deploy with docker compose' }))).toBe('infra');
    expect(classifyUnitRuleBased(unit({ title: 'How to install the CLI' }))).toBe('workflow');
    expect(classifyUnitRuleBased(unit({ title: 'Feature pricing' }))).toBe('product');
    expect(classifyUnitRuleBased(unit({ title: 'Amem memory system' }))).toBe('meta');
  });

  it('defaults unknown units to other', () => {
    expect(classifyUnitRuleBased(unit({ title: 'A random thought' }))).toBe('other');
  });
});

describe('classifyUnits (batch)', () => {
  it('only targets unclassified, non-archived units by default', async () => {
    const units = [
      unit({ id: 'u1', title: 'function: foo — a.ts', labels: {} }),
      unit({ id: 'u2', title: 'Deploy with docker', labels: {} }),
      unit({ id: 'u3', title: 'Already done', labels: { category: 'product' } }),
      unit({ id: 'u4', title: 'Archived one', labels: {}, status: 'archived' }),
    ];
    const report = await classifyUnits(undefined, units, {});
    expect(report.examined).toBe(2);
    expect(report.classified).toBe(2);
    expect(report.byCategory.code).toBe(1);
    expect(report.byCategory.infra).toBe(1);
    expect(units[0].labels.category).toBe('code');
    expect(units[1].labels.category).toBe('infra');
    expect(units[2].labels.category).toBe('product'); // untouched
    expect(units[3].labels.category).toBeUndefined(); // untouched
  });

  it('respects the ids filter and reclassify flag', async () => {
    const units = [
      unit({ id: 'u1', title: 'function: foo — a.ts', labels: { category: 'other' } }),
      unit({ id: 'u2', title: 'Deploy with docker', labels: {} }),
    ];
    const only = await classifyUnits(undefined, units, { ids: ['u1'] });
    expect(only.examined).toBe(0); // u1 already classified, u2 not selected
    expect(only.skipped).toBe(0);

    const redo = await classifyUnits(undefined, units, { ids: ['u1'], reclassify: true });
    expect(redo.examined).toBe(1);
    expect(units[0].labels.category).toBe('code');
  });

  it('uses LLM classification when the provider answers, rules otherwise', async () => {
    const llm = new MockLlmClient({
      [LLM_CLASSIFY_INTENT]: () => ({ category: 'research', reason: 'it is a question' }),
    });
    const units = [unit({ id: 'u1', title: 'function: foo — a.ts', labels: {} })];
    const report = await classifyUnits(llm, units, { mode: 'auto' });
    expect(report.viaLlm).toBe(1);
    expect(units[0].labels.category).toBe('research');
  });

  it('never lets an LLM failure block classification (rules fallback)', async () => {
    const llm = {
      completeJSON: async () => {
        throw new Error('provider down');
      },
    } as never;
    const units = [unit({ id: 'u1', title: 'Deploy with docker', labels: {} })];
    const report = await classifyUnits(llm as never, units, {});
    expect(report.viaRules).toBe(1);
    expect(units[0].labels.category).toBe('infra');
  });

  it('honors rules-only mode even with an LLM available', async () => {
    const llm = new MockLlmClient({
      [LLM_CLASSIFY_INTENT]: () => ({ category: 'research' }),
    });
    const units = [unit({ id: 'u1', title: 'function: foo — a.ts', labels: {} })];
    const report = await classifyUnits(llm, units, { mode: 'rules' });
    expect(report.viaRules).toBe(1);
    expect(report.viaLlm).toBe(0);
    expect(units[0].labels.category).toBe('code');
  });
});
