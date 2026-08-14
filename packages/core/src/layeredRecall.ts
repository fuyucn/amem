/**
 * Layered recall (TencentDB-Agent-Memory style L0-L3 routing).
 *
 * Context is assembled in order of token efficiency:
 *   1. L3 persona  — long-term profile (cheap, ~2000 chars cap).
 *   2. L2 scenario — compact project/area knowledge blocks.
 *   3. L1 units    — precise facts with citations, budget-gated.
 *
 * The assembled block is token-budgeted, so agents get the gist first and
 * the precise detail they have budget for.
 */
import type {
  AmemConfig,
  ContextItem,
  LayeredRecallResult,
  RecallInput,
  RoutedZone,
  Scenario,
  Source,
  Unit,
  UnitSummary,
  Zone,
} from './domain.js';
import type { Storage } from './store.js';
import type { Embedder } from './embedder.js';
import type { RequestContext } from './requestContext.js';
import { requireRequestContext, runWithRequestContextAsync } from './requestContext.js';
import { codeSymbolAdjustment, routeZone } from './recall.js';
import { accessibleZones, resolveExplicitZone } from './zones.js';
import { cosine } from './lib/vector.js';
import { countTokens } from './lib/tokenizer.js';
import { isNearDuplicateOf } from './lib/recallSelect.js';
import { recencyScore, toUnitSummary } from './lib/util.js';

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'did', 'was']);

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function keywordOverlap(query: string, text: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (haystack.includes(t)) hits++;
  return hits / terms.length;
}

function scenarioScore(query: string, scenario: Scenario): { score: number; reason: string } {
  const kw = keywordOverlap(
    query,
    [scenario.title, scenario.summary, ...scenario.tags, scenario.content.slice(0, 600)].join(' '),
  );
  if (kw > 0) {
    const heatBonus = Math.min(1, (scenario.heat ?? 0) / 50) * 0.25;
    const reason =
      heatBonus > 0
        ? `scenario keyword ${kw.toFixed(2)} + heat ${scenario.heat ?? 0}`
        : `scenario keyword ${kw.toFixed(2)}`;
    return { score: kw + heatBonus, reason };
  }
  return { score: 0, reason: 'baseline' };
}

function personaBlock(version: number, text: string): string {
  return `## Persona (v${version})\n${text}`;
}

function scenarioBlock(s: Scenario): string {
  const heat = s.heat ?? 0;
  const flames = heat >= 1000 ? '🔥🔥🔥🔥🔥' : heat >= 500 ? '🔥🔥🔥🔥' : heat >= 100 ? '🔥🔥🔥' : heat >= 50 ? '🔥🔥' : heat >= 10 ? '🔥' : '';
  const heatLine = flames ? `${flames} ${heat}` : `${heat}`;
  return `## Scenario: ${s.title} (heat ${heatLine})\n${s.summary}\n\n${s.content}`;
}

function unitBlock(unit: UnitSummary, body: string | undefined, sources: Source[]): string {
  const lines: string[] = [`[unit:${unit.title}](#${unit.id})`];
  if (unit.summary) lines.push(unit.summary);
  if (body) lines.push(body);
  if (sources.length > 0) lines.push(`Source: ${sources.map((s) => s.title).join(', ')}`);
  return lines.join('\n');
}

function scopeUnits(units: Unit[], ctx: RequestContext): Unit[] {
  if (!ctx.zoneIds || ctx.zoneIds.length === 0) return units;
  const allowed = new Set(ctx.zoneIds);
  return units.filter((u) => u.zoneId && allowed.has(u.zoneId));
}

function scopeScenarios(
  scenarios: Scenario[],
  units: Unit[],
  ctx: RequestContext,
): Scenario[] {
  if (!ctx.zoneIds || ctx.zoneIds.length === 0) return scenarios;
  const allowed = new Set(ctx.zoneIds);
  const unitZone = new Map(units.map((u) => [u.id, u.zoneId]));
  return scenarios.filter((s) =>
    s.sourceUnitIds.some((id) => {
      const zid = unitZone.get(id);
      return zid !== undefined && allowed.has(zid);
    }),
  );
}

/**
 * Layered recall. Budget split: persona ~15%, scenarios ~35%, units ~50%,
 * then L1 detail spills into whatever remains. Never throws.
 */
async function layeredRecallInner(
  storage: Storage,
  embed: Embedder,
  config: AmemConfig,
  input: RecallInput,
  ctx: RequestContext,
  routed: RoutedZone | undefined,
  zonesById: Map<string, Zone>,
): Promise<LayeredRecallResult> {
  const budget = input.tokenBudget ?? config.thresholds.recallBudget;
  const topK = input.topK ?? 10;
  const scenarioBudget = Math.floor(budget * 0.35);
  const unitBudget = Math.floor(budget * 0.5);
  const textParts: string[] = [];
  let used = 0;

  // L3 — persona bootstrap (when it fits the persona slice).
  const persona = await storage.getPersona();
  let personaOut: LayeredRecallResult['persona'];
  if (persona && persona.content.trim()) {
    const block = personaBlock(persona.version, persona.content);
    const tokens = countTokens(block);
    const personaSlice = Math.floor(budget * 0.15);
    if (used + tokens <= personaSlice) {
      textParts.push(block);
      used += tokens;
      personaOut = { version: persona.version, text: persona.content };
    }
  }

  // L2 — compact scenario blocks, best keyword matches first.
  const queryVecForScenarios = await embed.embed(input.query);
  const all = scopeUnits(await storage.allUnitsWithEmbeddings(), ctx);
  const scenarios = scopeScenarios(
    await storage.listScenarios({ status: 'active', limit: 50 }),
    all,
    ctx,
  );
  const scoredScenarios = scenarios
    .map((s) => ({ scenario: s, ...scenarioScore(input.query, s) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const selectedScenarios: LayeredRecallResult['scenarios'] = [];
  for (const { scenario, score, reason } of scoredScenarios) {
    const block = scenarioBlock(scenario);
    const tokens = countTokens(block);
    if (used + tokens > budget - unitBudget) break;
    if (used + tokens > scenarioBudget && selectedScenarios.length > 0) break;
    textParts.push(block);
    used += tokens;
    selectedScenarios.push({ scenario, score, reason });
    void storage.bumpScenarioHeat(scenario.id).catch(() => {});
  }

  // L1 — precise units with citations, gated by the unit slice.
  const queryVec = queryVecForScenarios;
  const coveredScenarioUnits = new Set(selectedScenarios.flatMap((s) => s.scenario.sourceUnitIds));
  const scored: Array<{ unit: Unit; score: number; reason: string }> = [];
  for (const unit of all) {
    if (unit.status === 'archived') continue;
    if (coveredScenarioUnits.has(unit.id)) continue; // already compressed into L2
    const reasons: string[] = [];
    let score = 0;
    if (unit.embedding) {
      const sim = cosine(queryVec, unit.embedding.values);
      score += sim * 0.5;
      if (sim > 0.01) reasons.push(`semantic ${sim.toFixed(2)}`);
    }
    const kw = keywordOverlap(
      input.query,
      [unit.title, unit.summary, ...unit.tags, unit.body.slice(0, 400)].join(' '),
    );
    score += kw * 0.3;
    if (kw > 0) reasons.push(`keyword ${kw.toFixed(2)}`);
    if (unit.status === 'pending') {
      score -= 0.12; // unreviewed extraction: correct but less trusted
      reasons.push('pending');
    }
    score += recencyScore(unit.updatedAt) * 0.1;
    score += unit.decay * 0.05;
    score += unit.importance * 0.05;
    const adjust = codeSymbolAdjustment(unit, input.query, config);
    score += adjust.delta;
    if (adjust.reason) reasons.push(adjust.reason);
    scored.push({ unit, score: Math.max(0, score), reason: reasons.join(', ') || 'baseline' });
  }
  scored.sort((a, b) => b.score - a.score);

  const items: ContextItem[] = [];
  let grounded = selectedScenarios.length > 0;
  const usedAfterL2 = used;
  const accepted: Array<{ unit: Unit; score: number; reason: string }> = [];
  let deduplicated = 0;
  for (const s of scored) {
    if (accepted.some((a) => isNearDuplicateOf(s.unit, a.unit))) {
      deduplicated++;
      continue;
    }
    accepted.push(s);
    const { unit, score, reason } = s;
    const sourceIds = await storage.distinctSourceIdsForUnit(unit.id);
    const sources = sourceIds.length > 0 ? await storage.sourcesByIds(sourceIds) : [];
    const block = unitBlock(
      toUnitSummary(unit),
      input.includeBody ? unit.body : undefined,
      sources,
    );
    const tokens = countTokens(block);
    const remaining = Math.max(0, unitBudget - (used - usedAfterL2));
    if (tokens > remaining && items.length > 0) break;
    if (used + tokens > budget) break;
    used += tokens;
    textParts.push(block);
    const summary = toUnitSummary(unit);
    const zone = summary.zoneId ? zonesById.get(summary.zoneId) : undefined;
    items.push({
      unit: zone ? { ...summary, zoneSlug: zone.slug, zoneName: zone.name } : summary,
      score,
      reason,
      citations: sources,
      zoneId: summary.zoneId,
      zoneSlug: zone?.slug,
      zoneName: zone?.name,
    });
    grounded = true;
    if (items.length >= topK) break;
  }

  return {
    query: input.query,
    budget,
    usedTokens: used,
    persona: personaOut,
    scenarios: selectedScenarios,
    units: items,
    text: textParts.join('\n\n'),
    grounded,
    deduplicated,
    routedZone: routed,
  };
}

/**
 * Layered recall with zone routing: explicit zone or auto-route narrows the
 * whole assembly to one partition; otherwise the accessible zone set applies.
 */
export async function layeredRecall(
  storage: Storage,
  embed: Embedder,
  config: AmemConfig,
  input: RecallInput,
): Promise<LayeredRecallResult> {
  const ctx = requireRequestContext();
  const zones = await accessibleZones(storage, ctx);
  const zonesById = new Map(zones.map((z) => [z.id, z]));
  const explicit = input.zone ? await resolveExplicitZone(input.zone, storage, ctx) : null;
  if (explicit) {
    return runWithRequestContextAsync({ ...ctx, zoneIds: [explicit.id] }, () =>
      layeredRecallInner(storage, embed, config, input, { ...ctx, zoneIds: [explicit.id] }, explicit, zonesById),
    );
  }
  // crossZone=true skips auto-routing and assembles from the full accessible
  // zone set. Default keeps routing (routed zone + inbox, weak-match fallback).
  const routed = input.crossZone ? null : await routeZone(input.query, ctx, storage, embed);
  if (routed) {
    // Same routing policy as recall(): the auto-routed zone plus the
    // workspace inbox stay in the candidate pool; everything else remains
    // isolated so unassigned memory is never unreachable.
    const scopeIds = new Set<string>([routed.id]);
    for (const zone of zones) {
      if (zone.kind === 'inbox') scopeIds.add(zone.id);
    }
    const routedScope = [...scopeIds];
    const scoped = await runWithRequestContextAsync({ ...ctx, zoneIds: routedScope }, () =>
      layeredRecallInner(storage, embed, config, input, { ...ctx, zoneIds: routedScope }, routed, zonesById),
    );
    // Routing is a preference, not a hard filter (same policy as recall()):
    // weak top match inside the auto-routed zone falls back to all zones.
    if (scoped.units[0]?.score !== undefined && scoped.units[0].score >= 0.35) {
      return scoped;
    }
    return layeredRecallInner(storage, embed, config, input, ctx, routed, zonesById);
  }
  return layeredRecallInner(storage, embed, config, input, ctx, undefined, zonesById);
}
