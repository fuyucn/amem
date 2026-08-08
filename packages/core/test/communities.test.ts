import { describe, expect, it } from 'vitest';
import { detectCommunities, countCommunities } from '../src/lib/communities.js';

describe('detectCommunities', () => {
  it('keeps isolated nodes as singletons and detects two clusters', () => {
    const nodes = ['a', 'b', 'c', 'x', 'y', 'z'];
    const edges = [
      { sourceUnitId: 'a', targetUnitId: 'b' },
      { sourceUnitId: 'b', targetUnitId: 'c' },
      { sourceUnitId: 'c', targetUnitId: 'a' },
      { sourceUnitId: 'x', targetUnitId: 'y' },
      { sourceUnitId: 'y', targetUnitId: 'z' },
    ];
    const labels = detectCommunities(nodes, edges);
    // a/b/c form one community, x/y/z another, 'z' isolated from a/b/c.
    expect(labels.get('a')).toBe(labels.get('b'));
    expect(labels.get('b')).toBe(labels.get('c'));
    expect(labels.get('x')).toBe(labels.get('y'));
    expect(labels.get('y')).toBe(labels.get('z'));
    expect(labels.get('a')).not.toBe(labels.get('x'));
    expect(countCommunities(labels)).toBe(2);
  });

  it('is deterministic across runs', () => {
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'];
    const edges = [
      { sourceUnitId: 'n1', targetUnitId: 'n2' },
      { sourceUnitId: 'n2', targetUnitId: 'n3' },
      { sourceUnitId: 'n3', targetUnitId: 'n1' },
      { sourceUnitId: 'n4', targetUnitId: 'n5' },
    ];
    const first = detectCommunities(nodes, edges);
    const second = detectCommunities(nodes, edges);
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
    expect(countCommunities(first)).toBe(2);
  });

  it('ignores self loops and returns singleton community for empty graph', () => {
    const nodes = ['a', 'b'];
    const labels = detectCommunities(nodes, [
      { sourceUnitId: 'a', targetUnitId: 'a' },
    ]);
    expect(labels.get('a')).not.toBe(labels.get('b'));
    expect(countCommunities(labels)).toBe(0);
  });
});
