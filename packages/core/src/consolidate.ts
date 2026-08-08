import type { AmemConfig, CurateReport } from './domain.js';
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

  const units = await storage.allUnitsWithEmbeddings();
  const byId = new Map(units.map((u) => [u.id, u]));

  // Prune auto tag-overlap links that no longer meet the current threshold
  // (e.g. tags changed or the threshold was raised). Semantic links are kept.
  let linksPruned = 0;
  for (const link of await storage.allLinks()) {
    if (!link.auto || !(link.reason ?? '').startsWith('shared-tags:')) continue;
    const a = byId.get(link.sourceUnitId);
    const b = byId.get(link.targetUnitId);
    if (!a || !b) continue;
    const shared = (a.tags ?? []).filter((t) => (b.tags ?? []).includes(t));
    if (shared.length < config.thresholds.minSharedTags) {
      await storage.deleteLink(link.id);
      linksPruned++;
    }
  }

  const linksCreated =
    embed && !opts?.skipLinks ? (await generateLinks(storage, embed, config)).linksCreated : 0;

  let crystalsPromoted = 0;
  for (const unit of units) {
    if (unit.status === 'archived' || unit.form === 'crystal') continue;
    const srcIds = await storage.distinctSourceIdsForUnit(unit.id);
    if (srcIds.length >= config.thresholds.minSourcesForCrystal) {
      unit.form = 'crystal';
      crystalsPromoted++;
    }
  }

  const nowMs = Date.now();
  let archived = 0;
  for (const unit of units) {
    // Absolute decay from last real update (not cumulative across curate runs).
    const days = ageInDays(unit.updatedAt, nowMs);
    const decayFromAge = Math.max(0, 1 - config.thresholds.decayPerDay * days);
    // Never raise decay above the unit's current value (manual forget can lower it).
    const decay = Math.min(unit.decay, decayFromAge);
    // Grace window: do not auto-archive very fresh knowledge.
    const graceDays = 7;
    if (
      decay < config.thresholds.forgetThreshold &&
      days >= graceDays &&
      unit.status !== 'pending' &&
      unit.form !== 'crystal'
    ) {
      unit.status = 'archived';
      archived++;
    }
    unit.decay = Math.max(0, Math.min(1, decay));
  }

  // Importance via undirected degree centrality.
  const links = await storage.allLinks();
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.sourceUnitId, (degree.get(l.sourceUnitId) ?? 0) + 1);
    degree.set(l.targetUnitId, (degree.get(l.targetUnitId) ?? 0) + 1);
  }
  let maxDegree = 0;
  for (const d of degree.values()) if (d > maxDegree) maxDegree = d;

  const contradictionsFlagged = links.filter((l) => l.relation === 'contradicts').length;
  for (const unit of units) {
    unit.importance = maxDegree > 0 ? (degree.get(unit.id) ?? 0) / maxDegree : 0;
  }

  for (const unit of units) await storage.updateUnit(unit);
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
