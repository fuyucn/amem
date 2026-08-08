/**
 * Deterministic graph community detection (label propagation).
 *
 * Each node starts with its own label; on every pass each node adopts the
 * label most frequent among its neighbors (ties broken by label order).
 * Node order and tie-breaking are fully deterministic so the result is
 * stable across runs — important for reproducible graph clustering.
 */

export interface CommunityEdge {
  sourceUnitId: string;
  targetUnitId: string;
}

const MAX_ITERATIONS = 20;

/**
 * Returns a stable mapping nodeId -> communityId for the given undirected
 * graph. Nodes without edges keep their own singleton community.
 */
export function detectCommunities(nodeIds: string[], edges: CommunityEdge[]): Map<string, string> {
  const nodes = [...nodeIds].sort();
  const adj = new Map<string, string[]>();
  for (const id of nodes) adj.set(id, []);
  for (const e of edges) {
    if (e.sourceUnitId === e.targetUnitId) continue;
    adj.get(e.sourceUnitId)?.push(e.targetUnitId);
    adj.get(e.targetUnitId)?.push(e.sourceUnitId);
  }
  // Label propagation with deterministic tie-breaking.
  const label = new Map<string, string>(nodes.map((id) => [id, id]));
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    for (const id of nodes) {
      const neighbors = adj.get(id) ?? [];
      if (neighbors.length === 0) continue;
      const counts = new Map<string, number>();
      for (const nb of neighbors) {
        const l = label.get(nb) ?? nb;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(id) ?? id;
      let bestCount = -1;
      for (const [l, c] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        if (c > bestCount) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

/**
 * Count non-trivial communities (>= 2 nodes). Isolated nodes are not
 * considered communities of their own for reporting purposes.
 */
export function countCommunities(communityMap: Map<string, string>): number {
  const sizes = new Map<string, number>();
  for (const c of communityMap.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  let count = 0;
  for (const size of sizes.values()) if (size >= 2) count++;
  return count;
}
