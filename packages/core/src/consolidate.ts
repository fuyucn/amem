import type { AmemConfig, CurateReport, Unit } from './domain.js';
import type { Storage } from './store.js';
import type { Embedder } from './embedder.js';
import { generateLinks } from './linkgen.js';
import { ageInDays } from './lib/util.js';

export interface ConsolidateOptions {
  /** skip costly link generation. */
  skipLinks?: boolean;
}

/** Promote crystals, generate links, decay/archive, and refresh importance. */
export async function consolidate(
  storage: Storage,
  config: AmemConfig,
  embed?: Embedder,
  opts?: ConsolidateOptions,
): Promise<CurateReport> {
  const jobId = await storage.recordJob({ kind: 'consolidate', status: 'running' });

  // Light read: consolidation only touches form/status/decay/importance, so
  // skip the (potentially megabytes of) embedding payloads entirely.
  const units = await storage.allUnits();
  const byId = new Map(units.map((u) => [u.id, u]));
  const allLinks = await storage.allLinks();

  // Prune auto tag-overlap links that no longer meet the current threshold
  // (e.g. tags changed or the threshold was raised). Semantic links are kept.
  const prunedIds: string[] = [];
  for (const link of allLinks) {
    if (!link.auto || !(link.reason ?? '').startsWith('shared-tags:')) continue;
    const a = byId.get(link.sourceUnitId);
    const b = byId.get(link.targetUnitId);
    if (!a || !b) continue;
    const shared = (a.tags ?? []).filter((t) => (b.tags ?? []).includes(t));
    if (shared.length < config.thresholds.minSharedTags) {
      prunedIds.push(link.id);
    }
  }
  const linksPruned = prunedIds.length;
  if (linksPruned > 0) await storage.deleteLinks(prunedIds);

  const pruned = new Set(prunedIds);
  const survivingLinks = allLinks.filter((l) => !pruned.has(l.id));
  const { linksCreated, created } =
    embed && !opts?.skipLinks
      ? await generateLinks(storage, embed, config, { existingLinks: survivingLinks })
      : { linksCreated: 0, created: [] };

  // Importance via undirected degree centrality.
  const links = [...survivingLinks, ...created];
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.sourceUnitId, (degree.get(l.sourceUnitId) ?? 0) + 1);
    degree.set(l.targetUnitId, (degree.get(l.targetUnitId) ?? 0) + 1);
  }
  let maxDegree = 0;
  for (const d of degree.values()) if (d > maxDegree) maxDegree = d;

  const contradictionsFlagged = links.filter((l) => l.relation === 'contradicts').length;

  // One pass: crystal promotion (single source-count query instead of N+1),
  // absolute decay + grace-window archiving, and degree centrality. Only
  // units whose persisted fields actually changed are written back, inside
  // a single transaction.
  const sourceCounts = await storage.sourceCountsByUnit();
  const minSources = config.thresholds.minSourcesForCrystal;
  const decayPerDay = config.thresholds.decayPerDay;
  const forgetThreshold = config.thresholds.forgetThreshold;
  const nowMs = Date.now();
  const graceDays = 7;
  // Write-back tolerance: decay/importance drift continuously with wall-clock
  // time and floating-point math; without an epsilon every pass would rewrite
  // the whole store. Only real (>=1e-9) changes are persisted.
  const EPS = 1e-9;
  let crystalsPromoted = 0;
  let archived = 0;
  const changed: Unit[] = [];
  for (const unit of units) {
    let next: Unit = unit;
    let dirty = false;
    if (next.status !== 'archived' && next.form !== 'crystal') {
      const srcCount = sourceCounts.get(next.id) ?? 0;
      if (srcCount >= minSources) {
        next = { ...next, form: 'crystal' };
        dirty = true;
        crystalsPromoted++;
      }
    }
    // Absolute decay from last real update (not cumulative across curate
    // runs). Quantized to whole days so the pass is idempotent within a day —
    // a continuous age curve would rewrite every unit on every run.
    const days = Math.floor(ageInDays(unit.updatedAt, nowMs));
    const decayFromAge = Math.max(0, 1 - decayPerDay * days);
    // Never raise decay above the unit's current value (manual forget can lower it).
    const decay = Math.min(unit.decay, decayFromAge);
    const clamped = Math.max(0, Math.min(1, decay));
    if (Math.abs(clamped - unit.decay) > EPS) {
      next = { ...next, decay: clamped };
      dirty = true;
    }
    // Grace window: do not auto-archive very fresh knowledge.
    if (
      clamped < forgetThreshold &&
      days >= graceDays &&
      next.status !== 'pending' &&
      next.form !== 'crystal'
    ) {
      next = { ...next, status: 'archived' };
      dirty = true;
      archived++;
    }
    const importance = maxDegree > 0 ? (degree.get(unit.id) ?? 0) / maxDegree : 0;
    if (Math.abs(importance - unit.importance) > EPS) {
      next = { ...next, importance };
      dirty = true;
    }
    if (dirty) changed.push(next);
  }
  await storage.updateUnits(changed);
  await storage.markJob(jobId, 'done');

  return {
    jobs: [jobId],
    linksCreated,
    linksPruned,
    crystalsPromoted,
    contradictionsFlagged,
    archived,
    summary: `consolidated: ${crystalsPromoted} crystal(s), ${linksCreated} link(s) created, ${linksPruned} link(s) pruned, ${archived} archived`,
  };
}
