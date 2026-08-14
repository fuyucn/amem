import type { Embedder } from './embedder.js';
import { AmemError } from './errors.js';
import { LLM_ZONE_ASSIGN_INTENT, type LlmClient } from './llm.js';
import type { Storage } from './store.js';
import type { NewUnit, RoutedZone, Zone, ZoneMember } from './domain.js';
import type { RequestContext } from './requestContext.js';
import { cosine, normalize, EMBED_BODY_HEAD } from './lib/vector.js';
import { slugify } from './okf.js';

/** Zones the caller may read/write: own personal zone, workspace-visible
 *  zones (inbox/shared), and explicit memberships. */
export interface ZoneAccess {
  zoneIds: string[];
  zones: Zone[];
}

/** Zones accessible to the caller: explicit ctx.zoneIds, or every zone when
 *  the caller is legacy (no zone scoping). */
export async function accessibleZones(storage: Storage, ctx: RequestContext): Promise<Zone[]> {
  const zones = (await storage.listZones()).filter((z) => z.status === 'active');
  if (!ctx.zoneIds || ctx.zoneIds.length === 0) return zones;
  const allowed = new Set(ctx.zoneIds);
  return zones.filter((z) => allowed.has(z.id));
}

/** Resolve an explicit zone reference (id or slug) against the accessible
 *  set. Throws when the caller asked for a partition they cannot read. */
export async function resolveExplicitZone(
  zoneRef: string,
  storage: Storage,
  ctx: RequestContext,
): Promise<RoutedZone | null> {
  const accessible = await accessibleZones(storage, ctx);
  const zone =
    accessible.find((z) => z.id === zoneRef) ?? accessible.find((z) => z.slug === zoneRef);
  if (!zone) {
    const exists = (await storage.listZones()).some((z) => z.id === zoneRef || z.slug === zoneRef);
    throw new AmemError(
      exists ? 'FORBIDDEN' : 'NOT_FOUND',
      exists
        ? `zone ${zoneRef} is not accessible in this scope`
        : `zone ${zoneRef} not found in this workspace`,
    );
  }
  return { id: zone.id, slug: zone.slug, name: zone.name, reason: 'explicit' };
}

export interface ZoneResolveOutcome {
  zone: Zone;
  via: 'explicit' | 'rules' | 'centroid' | 'llm' | 'inbox';
  score: number;
}

export interface ResolveZoneInput {
  storage: Storage;
  embed: Embedder;
  llm?: LlmClient;
  unit: Pick<NewUnit, 'zoneId' | 'title' | 'summary' | 'body' | 'tags' | 'type' | 'labels'>;
  /** Candidate zones (accessible). Defaults to every active zone in the workspace. */
  zones?: Zone[];
  /** Text used for the centroid embedding. Defaults to title + summary + body. */
  text?: string;
  /** Precomputed embedding vector for `text` (avoids a second embed call). */
  embeddingVec?: number[];
}

/** Resolution order: explicit > rules > centroid > LLM > inbox. */
export async function resolveZoneForWrite(input: ResolveZoneInput): Promise<ZoneResolveOutcome> {
  const candidates = (input.zones ?? (await input.storage.listZones())).filter((z) => z.status === 'active');
  const inbox = candidates.find((z) => z.kind === 'inbox');

  // 1. Explicit zone wins. Reject when it does not exist or is not accessible
  //    so a misplaced write can never silently land in another partition.
  if (input.unit.zoneId) {
    const explicit = candidates.find((z) => z.id === input.unit.zoneId);
    if (explicit) return { zone: explicit, via: 'explicit', score: 1 };
    const exists = await input.storage.getZone(input.unit.zoneId);
    if (!exists) {
      throw new AmemError('NOT_FOUND', `zone ${input.unit.zoneId} not found in this workspace`);
    }
    throw new AmemError('FORBIDDEN', `zone ${input.unit.zoneId} is not accessible in this scope`);
  }

  // 2. Deterministic offline rules (tags / category / title / type).
  const rulesHit = matchZoneByRules(input.unit, candidates);
  if (rulesHit) return { zone: rulesHit.zone, via: 'rules', score: rulesHit.score };

  // 3. Embedding centroid routing. Hash embeddings are not semantically
  //    comparable, so offline mode skips this branch entirely.
  if (input.embed.mode !== 'offline') {
    try {
      const vec = input.embeddingVec ?? (await input.embed.embed(input.text ?? embeddingText(input.unit)));
      let best: { zone: Zone; score: number } | null = null;
      for (const zone of candidates) {
        if (zone.kind === 'inbox' || !zone.embeddingCentroid) continue;
        const centroid = parseCentroid(zone.embeddingCentroid);
        if (!centroid) continue;
        const score = cosine(vec, centroid);
        if (score >= 0.6 && (!best || score > best.score)) best = { zone, score };
      }
      if (best) return { zone: best.zone, via: 'centroid', score: best.score };
    } catch {
      // Provider failures degrade gracefully to the LLM/rules fallbacks.
    }
  }

  // 4. LLM classification (best-effort; never blocks the write path).
  if (input.llm) {
    try {
      const zone = await classifyZoneByLlm(input.llm, input.unit, candidates);
      if (zone) return { zone, via: 'llm', score: 0.9 };
    } catch {
      // Provider failures degrade gracefully to the inbox fallback.
    }
  }

  // 5. Inbox fallback: uncategorized memory awaiting assignment.
  if (inbox) return { zone: inbox, via: 'inbox', score: 0 };
  throw new Error('no inbox zone available in this workspace');
}

interface RuleMatch {
  zone: Zone;
  score: number;
}

const PERSONAL_PREFERENCE_BONUS = 3;
const TAG_SCORE = 3;
const CATEGORY_SCORE = 2;
const TITLE_SCORE = 1.5;
const RULE_THRESHOLD = 3;

function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function matchZoneByRules(unit: ResolveZoneInput['unit'], candidates: Zone[]): RuleMatch | null {
  const tags = (unit.tags ?? []).map(normalizeKey);
  const category = unit.labels?.category != null ? normalizeKey(String(unit.labels.category)) : '';
  const title = unit.title.toLowerCase();
  let best: RuleMatch | null = null;

  for (const zone of candidates) {
    if (zone.kind === 'inbox') continue;
    const keys = new Set([normalizeKey(zone.slug), normalizeKey(zone.name)]);
    let score = 0;
    for (const tag of tags) {
      if (keys.has(tag)) {
        score += TAG_SCORE;
        break;
      }
    }
    if (category && keys.has(category)) score += CATEGORY_SCORE;
    for (const key of keys) {
      if (key && key.length >= 3 && title.includes(key)) {
        score += TITLE_SCORE;
        break;
      }
    }
    if (unit.type === 'preference' && zone.kind === 'personal') score += PERSONAL_PREFERENCE_BONUS;
    if (score >= RULE_THRESHOLD && (!best || score > best.score)) best = { zone, score };
  }
  return best;
}

async function classifyZoneByLlm(
  llm: LlmClient,
  unit: ResolveZoneInput['unit'],
  candidates: Zone[],
): Promise<Zone | null> {
  const prompt = [
    LLM_ZONE_ASSIGN_INTENT,
    `Available zones: ${candidates
      .filter((z) => z.kind !== 'inbox')
      .map((z) => `${z.slug} (${z.name})`)
      .join(', ')}.`,
    `Title: ${unit.title}`,
    unit.summary ? `Summary: ${unit.summary}` : '',
    unit.body ? `Body: ${unit.body.slice(0, 400)}` : '',
    `Tags: ${(unit.tags ?? []).join(', ') || '(none)'}`,
    `Type: ${unit.type}`,
    `Return JSON: {"zoneSlug":"<one of the slugs>","confidence":0.0-1.0}`,
  ]
    .filter(Boolean)
    .join('\n');
  const out = await llm.completeJSON<{ zoneSlug?: string; confidence?: number }>(prompt, { maxTokens: 200 });
  const zone = candidates.find((z) => z.slug === out?.zoneSlug);
  if (zone && (out.confidence ?? 1) >= 0.4) return zone;
  return null;
}

function embeddingText(unit: ResolveZoneInput['unit']): string {
  return [unit.title, unit.summary ?? '', (unit.body ?? '').slice(0, EMBED_BODY_HEAD)]
    .filter(Boolean)
    .join(' ');
}

function parseCentroid(raw: string): number[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) && value.every((v) => typeof v === 'number') ? (value as number[]) : null;
  } catch {
    return null;
  }
}

/**
 * Recompute the embedding centroid of every zone from its units. Centroid
 * routing requires a real (API) embedder — offline hash vectors are not
 * semantically comparable, so offline mode is skipped.
 */
export async function recomputeZoneCentroids(
  storage: Storage,
  embed: Embedder,
): Promise<{ updated: number; skippedOffline: boolean }> {
  if (embed.mode === 'offline') return { updated: 0, skippedOffline: true };
  const units = await storage.allUnitsWithEmbeddings();
  const byZone = new Map<string, number[][]>();
  for (const u of units) {
    if (!u.embedding?.values?.length || !u.zoneId) continue;
    const list = byZone.get(u.zoneId) ?? [];
    list.push(u.embedding.values);
    byZone.set(u.zoneId, list);
  }
  let updated = 0;
  for (const [zoneId, vecs] of byZone) {
    const zone = await storage.getZone(zoneId);
    if (!zone || zone.status !== 'active') continue;
    const dims = vecs[0]?.length ?? 0;
    if (dims === 0) continue;
    const centroid = normalize(
      Array.from({ length: dims }, (_, i) => vecs.reduce((sum, v) => sum + (v[i] ?? 0), 0) / vecs.length),
    );
    zone.embeddingCentroid = JSON.stringify(centroid);
    await storage.updateZone(zone);
    updated += 1;
  }
  return { updated, skippedOffline: false };
}

export interface ZoneProposal {
  slug: string;
  name: string;
  description: string;
  unitIds: string[];
  sampleTitles: string[];
  size: number;
  /** 0..1 average similarity of cluster members to the centroid. */
  cohesion: number;
}

export interface ProposeZonesOptions {
  /** Minimum cluster size for a proposal. Default 5. */
  minClusterSize?: number;
  /** Cosine similarity threshold for joining a cluster. Default 0.65. */
  similarity?: number;
  /** Cap on the number of units examined. Default 600. */
  maxUnits?: number;
  /** Cap on the number of proposals returned. Default 10. */
  maxProposals?: number;
}

const STOP_TAGS = new Set(['amem', 'knowledge', 'memory', 'general', 'misc', 'notes']);
const TITLE_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'did', 'was', 'are',
  'from', 'into', 'about', 'unit', 'units', 'note', 'notes', 'knowledge',
]);

/**
 * Greedy agglomerative clustering over unassigned (inbox/shared) units.
 * Proposals are advisory — a human confirms them in the Zones UI before a
 * zone is created and units are moved.
 */
export async function proposeNewZones(
  storage: Storage,
  embed: Embedder,
  opts: ProposeZonesOptions = {},
): Promise<ZoneProposal[]> {
  const minClusterSize = opts.minClusterSize ?? 5;
  const similarity = opts.similarity ?? 0.65;
  const maxUnits = opts.maxUnits ?? 600;
  const maxProposals = opts.maxProposals ?? 10;

  const zones = await storage.listZones();
  const existingSlugs = new Set(zones.map((z) => z.slug));
  const kindByZone = new Map(zones.map((z) => [z.id, z.kind]));
  const units = (await storage.allUnitsWithEmbeddings(maxUnits)).filter((u) => {
    const kind = kindByZone.get(u.zoneId ?? '');
    return kind === 'inbox' || kind === 'shared';
  });

  interface Cluster {
    centroid: number[];
    vecs: number[][];
    unitIds: string[];
    titles: string[];
    tags: string[];
  }
  const clusters: Cluster[] = [];
  for (const u of units) {
    const vec = u.embedding?.values;
    if (!vec?.length) continue;
    let best: Cluster | null = null;
    let bestScore = -1;
    for (const cluster of clusters) {
      const score = cosine(vec, cluster.centroid);
      if (score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }
    if (best && bestScore >= similarity) {
      const n = best.vecs.length;
      best.centroid = best.centroid.map((v, i) => (v * n + (vec[i] ?? 0)) / (n + 1));
      best.vecs.push(vec);
      best.unitIds.push(u.id);
      best.titles.push(u.title);
      best.tags.push(...(u.tags ?? []));
    } else {
      clusters.push({
        centroid: [...vec],
        vecs: [vec],
        unitIds: [u.id],
        titles: [u.title],
        tags: [...(u.tags ?? [])],
      });
    }
  }

  const proposals: ZoneProposal[] = [];
  const proposedSlugs = new Set<string>();
  for (const cluster of clusters) {
    if (cluster.unitIds.length < minClusterSize) continue;
    const name = clusterName(cluster);
    const slug = uniqueSlug(name, existingSlugs, proposedSlugs);
    const centroid = normalize(cluster.centroid);
    const cohesion =
      cluster.vecs.reduce((sum, v) => sum + cosine(v, centroid), 0) / cluster.vecs.length;
    proposals.push({
      slug,
      name,
      description: `Auto-proposed zone from ${cluster.unitIds.length} related units`,
      unitIds: cluster.unitIds,
      sampleTitles: cluster.titles.slice(0, 5),
      size: cluster.unitIds.length,
      cohesion,
    });
  }
  proposals.sort((a, b) => b.size - a.size);
  return proposals.slice(0, maxProposals);
}

function clusterName(cluster: { tags: string[]; titles: string[] }): string {
  const tagCounts = new Map<string, number>();
  for (const raw of cluster.tags) {
    const tag = raw.trim().toLowerCase();
    if (!tag || STOP_TAGS.has(tag)) continue;
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  let bestTag = '';
  let bestCount = 0;
  for (const [tag, count] of tagCounts) {
    if (count > bestCount) {
      bestTag = tag;
      bestCount = count;
    }
  }
  if (bestTag) return bestTag.charAt(0).toUpperCase() + bestTag.slice(1);

  const tokenCounts = new Map<string, number>();
  for (const title of cluster.titles) {
    for (const token of title.toLowerCase().split(/[^\w]+/)) {
      if (token.length < 4 || TITLE_STOP.has(token)) continue;
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }
  let bestToken = '';
  let bestTokenCount = 0;
  for (const [token, count] of tokenCounts) {
    if (count > bestTokenCount) {
      bestToken = token;
      bestTokenCount = count;
    }
  }
  return bestToken ? bestToken.charAt(0).toUpperCase() + bestToken.slice(1) : 'Cluster';
}

function uniqueSlug(base: string, existing: Set<string>, proposed: Set<string>): string {
  const root = slugify(base) || 'cluster';
  let slug = root;
  let n = 2;
  while (existing.has(slug) || proposed.has(slug)) {
    slug = `${root}-${n}`;
    n += 1;
  }
  proposed.add(slug);
  return slug;
}

/**
 * Zones a user may read/write in the current workspace:
 *  1. their own personal zone,
 *  2. every workspace-visible zone (inbox + shared),
 *  3. zones they are an explicit member of.
 * With no user (legacy/anonymous), only workspace-visible zones are returned.
 */
export async function getZoneAccess(storage: Storage, userId?: string): Promise<ZoneAccess> {
  const zones = await storage.listZones();
  const accessible: Zone[] = [];
  for (const zone of zones) {
    if (zone.status !== 'active') continue;
    if (zone.visibility === 'workspace') {
      accessible.push(zone);
      continue;
    }
    if (userId && zone.ownerUserId === userId) {
      accessible.push(zone);
      continue;
    }
    if (!userId) continue;
    const members = await storage.listZoneMembers(zone.id);
    if (members.some((m) => m.userId === userId)) accessible.push(zone);
  }
  return { zoneIds: accessible.map((z) => z.id), zones: accessible };
}

/** Minimal synchronous zone lookup used by request-context scoping.
 *  better-sqlite3 is synchronous, so the server can resolve a caller's
 *  accessible zones without an await — required for ALS enterWith to
 *  propagate into Fastify handlers (an await before enterWith loses the
 *  context). */
export interface ZoneLookup {
  listZonesSync(): Zone[];
  listZoneMembersSync(zoneId: string): ZoneMember[];
}

/** Synchronous counterpart of {@link getZoneAccess} for request-context
 *  scoping (no async boundary before ALS enterWith). */
export function getZoneAccessSync(storage: ZoneLookup, userId?: string): ZoneAccess {
  const zones = storage.listZonesSync();
  const accessible: Zone[] = [];
  for (const zone of zones) {
    if (zone.status !== 'active') continue;
    if (zone.visibility === 'workspace') {
      accessible.push(zone);
      continue;
    }
    if (userId && zone.ownerUserId === userId) {
      accessible.push(zone);
      continue;
    }
    if (!userId) continue;
    const members = storage.listZoneMembersSync(zone.id);
    if (members.some((m) => m.userId === userId)) accessible.push(zone);
  }
  return { zoneIds: accessible.map((z) => z.id), zones: accessible };
}
