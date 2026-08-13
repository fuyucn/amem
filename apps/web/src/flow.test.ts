import { describe, expect, it } from 'vitest';
import type { ActivitySummary } from './types';
import { accessRows, actorTotal, flowCards, regionRows } from './flow';

function summary(over: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    window: { events: 5, hours: 24, since: '2026-08-13T00:00:00.000Z' },
    input: { total: 3, byKind: { ingest: 2, save_unit: 1 }, unitsCreated: 4 },
    output: { total: 2, byKind: { recall: 1, search: 1 }, tokensDelivered: 1200, budgetUsed: 5000, tokenSavings: 3800 },
    accessedUnits: [
      {
        unitId: 'u1',
        title: 'Deploy checklist',
        type: 'procedure',
        category: 'ops',
        tags: ['deploy', 'docker'],
        accessCount: 3,
        lastAccessedAt: '2026-08-13T01:00:00.000Z',
        actors: ['codex'],
      },
      {
        unitId: 'u2',
        title: 'API auth flow',
        type: 'concept',
        category: 'security',
        tags: ['oauth', 'pkce', 'scope'],
        accessCount: 1,
        lastAccessedAt: '2026-08-13T00:30:00.000Z',
        actors: ['codex', 'claude'],
      },
    ],
    regions: {
      byType: [
        { key: 'procedure', count: 1 },
        { key: 'concept', count: 1 },
      ],
      byCategory: [
        { key: 'ops', count: 1 },
        { key: 'security', count: 1 },
      ],
      byTag: [
        { key: 'oauth', count: 1 },
        { key: 'docker', count: 1 },
        { key: 'pkce', count: 1 },
      ],
    },
    topActors: [
      { actor: 'codex', writes: 3, reads: 2 },
      { actor: 'claude', writes: 0, reads: 1 },
    ],
    ...over,
  };
}

describe('flowCards', () => {
  it('summarizes input/output counts and token economics', () => {
    const cards = flowCards(summary());
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(byId.in!.value).toBe(3);
    expect(byId.in!.detail).toContain('4 units distilled');
    expect(byId.out!.value).toBe(2);
    expect(byId.out!.detail).toContain('1,200 tokens delivered');
    expect(byId.saved!.value).toBe(3800);
    expect(byId.events!.value).toBe(5);
  });

  it('falls back to empty detail when no kind is recorded', () => {
    const cards = flowCards(summary({ input: { total: 0, byKind: {}, unitsCreated: 0 } }));
    expect(cards[0]!.value).toBe(0);
    expect(cards[0]!.detail).toBe('0 units distilled');
  });
});

describe('regionRows', () => {
  it('sorts by count desc and attaches a share of total', () => {
    const rows = regionRows(
      [
        { key: 'a', count: 1 },
        { key: 'b', count: 3 },
      ],
      4,
    );
    expect(rows[0]!).toEqual({ key: 'b', count: 3, pct: 75 });
    expect(rows[1]!).toEqual({ key: 'a', count: 1, pct: 25 });
  });

  it('returns empty rows for empty input and avoids divide-by-zero', () => {
    expect(regionRows([], 0)).toEqual([]);
    expect(regionRows([{ key: 'x', count: 0 }], 0)).toEqual([{ key: 'x', count: 0, pct: 0 }]);
  });
});

describe('accessRows', () => {
  it('caps the returned rows and tags to compact chip lists', () => {
    const rows = accessRows(summary(), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitId).toBe('u1');
    expect(rows[0]!.tags).toEqual(['deploy', 'docker']);
  });

  it('is safe for null or empty summaries', () => {
    expect(accessRows(null)).toEqual([]);
    expect(accessRows(summary({ accessedUnits: [] }))).toEqual([]);
  });
});

describe('actorTotal', () => {
  it('sums writes and reads', () => {
    expect(actorTotal({ actor: 'codex', writes: 3, reads: 2 })).toBe(5);
    expect(actorTotal({ actor: 'claude', writes: 0, reads: 0 })).toBe(0);
  });
});
