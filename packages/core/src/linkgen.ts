import type { AmemConfig, LinkRelation, Unit } from './domain.js';
import type { Storage } from './store.js';
import type { Embedder } from './embedder.js';
import { cosine } from './lib/vector.js';
import { newId, nowIso } from './lib/util.js';

const MAX_PAIR_UNITS = 500;
const MIN_TAG_LINK_CONFIDENCE = 0.5;

const CONTRADICT_RE = /contradict|oppos|disagree|conflict|however|whereas|but\b/i;
const SUPPORTS_RE = /support|evidence|confirm|corrobor|reinforc|validat/i;
const EXTENDS_RE = /extend|further|moreover|additionally|develop|expand/i;
const PART_OF_RE = /part of|component|consist|compose|include|contain|belong/i;
const PRECEDES_RE = /\bbefore\b|\bthen\b|\bnext\b|\bprior\b|subsequent|preced|step\b|follow/i;

/** Strong, typed relations beat generic `related_to` when ranking candidates. */
function relationRank(relation: LinkRelation): number {
  return relation === 'related_to' ? 1 : 0;
}

function relationFor(a: Unit, b: Unit): LinkRelation {
  const text = `${a.title} ${a.summary} ${b.title} ${b.summary}`;
  if (CONTRADICT_RE.test(text)) return 'contradicts';
  if (SUPPORTS_RE.test(text)) return 'supports';
  if (EXTENDS_RE.test(text)) return 'extends';
  if (PART_OF_RE.test(text)) return 'part_of';
  if (PRECEDES_RE.test(text)) return 'precedes';
  return 'related_to';
}

/** Canonical, direction-independent key so a pair is never linked twice. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

interface LinkCandidate {
  a: Unit;
  b: Unit;
  confidence: number;
  relation: LinkRelation;
  reason: string;
}

/**
 * Generate typed links between similar active units with a bounded degree:
 * every unit keeps at most `thresholds.maxLinksPerUnit` of its strongest
 * candidates. Without the cap, a shared generic tag links near-all pairs and
 * the knowledge graph degenerates into a hairball.
 */
export async function generateLinks(
  storage: Storage,
  _embed: Embedder,
  config: AmemConfig,
): Promise<{ linksCreated: number }> {
  const units = await storage.allUnitsWithEmbeddings();
  const active = units.filter((u) => u.status !== 'archived' && u.embedding);
  const shortlist = active.slice(0, MAX_PAIR_UNITS);
  const maxLinksPerUnit = Math.max(1, config.thresholds.maxLinksPerUnit ?? 8);

  // Pre-collect existing edges keyed canonically (direction-independent).
  const existingKeys = new Set<string>();
  const allLinks = await storage.allLinks();
  for (const l of allLinks) {
    existingKeys.add(pairKey(l.sourceUnitId, l.targetUnitId));
  }

  // Score every pair once, then rank per unit and keep the top-K candidates.
  const perUnit = new Map<string, LinkCandidate[]>();
  for (let i = 0; i < shortlist.length; i++) {
    const a = shortlist[i];
    if (!a) continue;
    const aEmbedding = a.embedding;
    if (!aEmbedding) continue;
    for (let j = i + 1; j < shortlist.length; j++) {
      const b = shortlist[j];
      if (!b) continue;
      const bEmbedding = b.embedding;
      if (!bEmbedding) continue;
      const sim = cosine(aEmbedding.values, bEmbedding.values);
      // Semantic similarity is the primary signal (requires a real embedding
      // API; the offline hash embedder is near-orthogonal). Fall back to a
      // deterministic tag-overlap signal so the graph grows even offline.
      const sharedTags = (a.tags ?? []).filter((t) => (b.tags ?? []).includes(t));
      let confidence: number;
      let reason: string;
      // Typed relations (supports/extends/part_of/...) carry semantic weight,
      // so they are only assigned on real semantic similarity. The shared-tag
      // fallback is a weak signal and only ever produces `related_to`; giving
      // it typed relations made generic tags (e.g. `code`, `codegraph`)
      // mass-produce garbage `extends`/`supports` hubs in the graph.
      let relation: LinkRelation = 'related_to';
      if (sim >= config.thresholds.linkSimThreshold) {
        confidence = sim;
        reason = `auto-linked: "${a.title}" ~ "${b.title}"`;
        relation = relationFor(a, b);
      } else if (sharedTags.length >= config.thresholds.minSharedTags) {
        const minTagCount = Math.min(a.tags?.length ?? 1, b.tags?.length ?? 1);
        confidence = Math.min(0.8, sharedTags.length / Math.max(1, minTagCount) + 0.3);
        if (confidence < MIN_TAG_LINK_CONFIDENCE) continue;
        reason = `shared-tags: ${sharedTags.slice(0, 4).join(', ')}`;
      } else {
        continue;
      }
      const candidate: LinkCandidate = {
        a,
        b,
        confidence,
        relation,
        reason,
      };
      const listA = perUnit.get(a.id) ?? [];
      listA.push(candidate);
      perUnit.set(a.id, listA);
      const listB = perUnit.get(b.id) ?? [];
      listB.push(candidate);
      perUnit.set(b.id, listB);
    }
  }

  // Union of each unit's top-K picks; a pair is kept if either side keeps it.
  const chosen = new Map<string, LinkCandidate>();
  for (const list of perUnit.values()) {
    list.sort(
      (p, q) =>
        q.confidence - p.confidence ||
        relationRank(p.relation) - relationRank(q.relation) ||
        p.a.id.localeCompare(q.a.id),
    );
    for (const candidate of list.slice(0, maxLinksPerUnit)) {
      chosen.set(pairKey(candidate.a.id, candidate.b.id), candidate);
    }
  }

  const created = new Set<string>();
  let linksCreated = 0;
  for (const key of [...chosen.keys()].sort()) {
    if (existingKeys.has(key) || created.has(key)) continue;
    const candidate = chosen.get(key);
    if (!candidate) continue;
    const { a, b, confidence, relation, reason } = candidate;
    // Keep direction canonical so the unique(source, target, relation) index
    // never holds both orientations of the same pair.
    const [source, target] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    if (existingKeys.has(pairKey(source, target))) continue;
      await storage.createLink({
        id: newId('link'),
        sourceUnitId: source,
        targetUnitId: target,
        relation,
        reason,
        confidence,
        auto: true,
        createdAt: nowIso(),
      });
      created.add(key);
      linksCreated++;
  }
  return { linksCreated };
}
