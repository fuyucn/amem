import type {
  AmemConfig,
  ContextItem,
  RecallInput,
  RecallResult,
  RoutedZone,
  Source,
  Unit,
  UnitType,
  UnitSummary,
  Zone,
} from './domain.js';
import type { Storage } from './store.js';
import type { Embedder } from './embedder.js';
import type { RequestContext } from './requestContext.js';
import { requireRequestContext, runWithRequestContextAsync } from './requestContext.js';
import { accessibleZones, resolveExplicitZone } from './zones.js';
import { isCodeSymbolUnit } from './classify.js';
import { cosine } from './lib/vector.js';
import { countTokens } from './lib/tokenizer.js';
import { isNearDuplicateOf } from './lib/recallSelect.js';
import { recencyScore, toUnitSummary } from './lib/util.js';

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'did', 'was']);
/** Code-flavoured queries keep code-symbol units relevant (no demotion). */
const CODE_QUERY_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|rb|php|sh|sql|json|ya?ml)\b|\b(function|class|interface|module|import|export|const|let|var|def|func|fn|type|enum|struct|impl|api|route|endpoint|schema|component|hook)\b/i;
const KNOWLEDGE_TYPES: ReadonlySet<UnitType> = new Set([
  'procedure',
  'decision',
  'lesson',
  'plan',
  'preference',
  'concept',
]);

interface Scored {
  unit: Unit;
  score: number;
  reason: string;
}

function zoneKeywordScore(query: string, zone: Zone): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  // Identity match must be a whole token: "persona" is not "personal", and
  // "user" in a slug is not a routing signal. Description overlap may stay
  // substring-based (it only contributes the weaker half).
  const identityTokens = new Set(
    `${zone.name} ${zone.slug}`
      .toLowerCase()
      .split(/[^a-z0-9\u3400-\u9fff]+/)
      .filter(Boolean),
  );
  const haystack = `${zone.name} ${zone.slug} ${zone.description ?? ''}`.toLowerCase();
  let identityHit = 0;
  let hits = 0;
  for (const t of terms) {
    if (identityTokens.has(t)) identityHit = 1;
    if (haystack.includes(t)) hits++;
  }
  // A direct name/slug match gives a strong base even when the query has
  // unrelated extra terms; description overlap adds the rest.
  return identityHit * 0.5 + (hits / terms.length) * 0.5;
}

function parseCentroid(raw?: string): number[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) && value.every((v) => typeof v === 'number') ? (value as number[]) : null;
  } catch {
    return null;
  }
}

/** Auto-route a query to the best-matching accessible zone. Scoring combines
 *  keyword overlap on the zone name/slug/description with embedding-centroid
 *  similarity. Returns null when no zone clears the 0.35 threshold (caller
 *  stays on the full accessible set). */
export async function routeZone(
  query: string,
  ctx: RequestContext,
  storage: Storage,
  embed: Embedder,
): Promise<RoutedZone | null> {
  const accessible = await accessibleZones(storage, ctx);
  if (accessible.length === 0) return null;
  let queryVec: number[] | null = null;
  if (embed.mode !== 'offline') {
    try {
      queryVec = await embed.embed(query);
    } catch {
      // centroid routing degrades to keyword-only when the provider fails
    }
  }
  let best: { zone: Zone; score: number } | null = null;
  for (const zone of accessible) {
    let score = zoneKeywordScore(query, zone) * 0.8;
    if (queryVec) {
      const centroid = parseCentroid(zone.embeddingCentroid);
      if (centroid) score += Math.max(0, cosine(queryVec, centroid)) * 0.4;
    }
    if (!best || score > best.score) best = { zone, score };
  }
  if (!best || best.score < 0.35) return null;
  return {
    id: best.zone.id,
    slug: best.zone.slug,
    name: best.zone.name,
    reason: `auto-routed (${best.score.toFixed(2)})`,
  };
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function keywordOverlap(query: string, unit: Unit): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const haystack = [unit.title, unit.summary, ...unit.tags, unit.body.slice(0, 400)]
    .join(' ')
    .toLowerCase();
  let hits = 0;
  for (const t of terms) if (haystack.includes(t)) hits++;
  return hits / terms.length;
}

/** Natural-language query => demote auto-extracted code symbols, boost knowledge units. */
export function codeSymbolAdjustment(
  unit: Unit,
  query: string,
  config: AmemConfig,
): { delta: number; reason?: string } {
  if (CODE_QUERY_RE.test(query)) return { delta: 0 };
  if (isCodeSymbolUnit(unit)) {
    return { delta: -config.thresholds.codeSymbolPenalty, reason: 'code-symbol' };
  }
  if (KNOWLEDGE_TYPES.has(unit.type)) {
    return { delta: config.thresholds.knowledgeBoost, reason: 'knowledge' };
  }
  return { delta: 0 };
}

function buildBlock(unit: UnitSummary, body: string | undefined, sources: Source[]): string {
  const lines: string[] = [`[unit:${unit.title}](#${unit.id})`];
  if (unit.summary) lines.push(unit.summary);
  if (body) lines.push(body);
  if (sources.length > 0) lines.push(`Source: ${sources.map((s) => s.title).join(', ')}`);
  return lines.join('\n');
}

interface ZoneMeta {
  byId: Map<string, Zone>;
}

async function zoneMeta(storage: Storage): Promise<ZoneMeta> {
  const zones = await storage.listZones();
  return { byId: new Map(zones.map((z) => [z.id, z])) };
}

function scopeUnits(units: Unit[], ctx: RequestContext, _meta: ZoneMeta): Unit[] {
  if (!ctx.zoneIds || ctx.zoneIds.length === 0) return units;
  const allowed = new Set(ctx.zoneIds);
  return units.filter((u) => u.zoneId && allowed.has(u.zoneId));
}

function annotate(unit: UnitSummary, meta: ZoneMeta): UnitSummary {
  if (!unit.zoneId) return unit;
  const zone = meta.byId.get(unit.zoneId);
  if (!zone) return unit;
  return { ...unit, zoneSlug: zone.slug, zoneName: zone.name };
}

async function recallInner(
  storage: Storage,
  embed: Embedder,
  config: AmemConfig,
  input: RecallInput,
  ctx: RequestContext,
  routed: RoutedZone | undefined,
  meta: ZoneMeta,
): Promise<RecallResult> {
  const budget = input.tokenBudget ?? config.thresholds.recallBudget;
  const topK = input.topK ?? 10;
  const queryVec = await embed.embed(input.query);
  const all = scopeUnits(await storage.allUnitsWithEmbeddings(), ctx, meta);

  const scored: Scored[] = [];
  for (const unit of all) {
    if (unit.status === 'archived') continue;
    const reasons: string[] = [];
    let score = 0;
    if (unit.embedding) {
      const sim = cosine(queryVec, unit.embedding.values);
      score += sim * 0.5;
      if (sim > 0.01) reasons.push(`semantic ${sim.toFixed(2)}`);
    }
    const kw = keywordOverlap(input.query, unit);
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
  // Accuracy guard: suppress near-duplicates of an already-accepted unit so
  // the agent sees one canonical block per fact instead of N paraphrases.
  const accepted: Array<{ unit: Unit; score: number }> = [];
  let deduplicated = 0;
  const top: typeof scored = [];
  for (const s of scored) {
    if (accepted.some((a) => isNearDuplicateOf(s.unit, a.unit))) {
      deduplicated++;
      continue;
    }
    accepted.push(s);
    top.push(s);
    if (top.length >= topK) break;
  }

  const items: ContextItem[] = [];
  const textParts: string[] = [];
  let used = 0;
  let grounded = false;

  for (const { unit, score, reason } of top) {
    const sourceIds = await storage.distinctSourceIdsForUnit(unit.id);
    const sources = sourceIds.length > 0 ? await storage.sourcesByIds(sourceIds) : [];
    const block = buildBlock(
      toUnitSummary(unit),
      input.includeBody ? unit.body : undefined,
      sources,
    );
    const tokens = countTokens(block);
    if (used + tokens > budget) break;
    used += tokens;
    textParts.push(block);
    if (sources.length > 0) grounded = true;
    items.push({ unit: toUnitSummary(unit), score, reason, citations: sources });
  }

  const annotated = items.map((item) => {
    const zone = item.unit.zoneId ? meta.byId.get(item.unit.zoneId) : undefined;
    return {
      ...item,
      unit: annotate(item.unit, meta),
      zoneId: item.unit.zoneId,
      zoneSlug: zone?.slug,
      zoneName: zone?.name,
    };
  });

  return {
    query: input.query,
    budget,
    usedTokens: used,
    items: annotated,
    text: textParts.join('\n\n'),
    grounded,
    deduplicated,
    routedZone: routed,
  };
}

/** Hybrid semantic + keyword + recency/decay/importance recall with token
 *  budgeting and zone routing. */
export async function recall(
  storage: Storage,
  embed: Embedder,
  config: AmemConfig,
  input: RecallInput,
): Promise<RecallResult> {
  const ctx = requireRequestContext();
  const meta = await zoneMeta(storage);
  const explicit = input.zone ? await resolveExplicitZone(input.zone, storage, ctx) : null;
  if (explicit) {
    return runWithRequestContextAsync({ ...ctx, zoneIds: [explicit.id] }, () =>
      recallInner(storage, embed, config, input, { ...ctx, zoneIds: [explicit.id] }, explicit, meta),
    );
  }
  // crossZone=true skips auto-routing and searches the full accessible zone
  // set ("I don't care which partition it lives in"). Default keeps routing.
  const routed = input.crossZone ? null : await routeZone(input.query, ctx, storage, embed);
  if (routed) {
    // Routing is a preference, not a hard filter. Keep the workspace inbox
    // (uncategorized memory awaiting assignment) inside the candidate pool so
    // newly ingested units stay recallable even when the query auto-routes to
    // a specific partition. Other partitions remain strictly isolated.
    const scopeIds = await routedScopeIds(routed, ctx, storage, meta);
    const scoped = await runWithRequestContextAsync({ ...ctx, zoneIds: scopeIds }, () =>
      recallInner(storage, embed, config, input, { ...ctx, zoneIds: scopeIds }, routed, meta),
    );
    // Routing is a preference, not a hard filter: when the best match inside
    // the auto-routed zone is weak (e.g. "shared" matched as a routing hint
    // but the real target lives in Inbox), fall back to all accessible zones.
    if (scoped.items[0]?.score !== undefined && scoped.items[0].score >= 0.35) {
      return scoped;
    }
    return recallInner(storage, embed, config, input, ctx, routed, meta);
  }
  return recallInner(storage, embed, config, input, ctx, undefined, meta);
}

/** Candidate zones for an auto-routed recall: the routed zone plus the
 *  workspace inbox (unassigned memory must never be unreachable). */
async function routedScopeIds(
  routed: RoutedZone,
  ctx: RequestContext,
  storage: Storage,
  _meta: ZoneMeta,
): Promise<string[]> {
  const ids = new Set<string>([routed.id]);
  for (const zone of await accessibleZones(storage, ctx)) {
    if (zone.kind === 'inbox') ids.add(zone.id);
  }
  return [...ids];
}
