import type {
  ActivityEvent,
  ActivityFilter,
  AmemConfig,
  AmemService,
  Asset,
  AssetCallResult,
  AssetId,
  AssetKind,
  AssetRouteResult,
  AssetStatus,
  AssetVersion,
  RouteAssetsInput,
  CurateReport,
  ExportBundle,
  Graph,
  ImportCodebaseInput,
  ImportDirInput,
  ImportResult,
  ImportSessionsInput,
  ImportSourcesResult,
  IngestInput,
  IngestResult,
  LayerRefreshResult,
  LayeredRecallResult,
  Link,
  LinkRelation,
  NewUnit,
  NodeCluster,
  Persona,
  RecallInput,
  RecallResult,
  Scenario,
  ScenarioId,
  ScenarioStatus,
  AssetExtractResult,
  CompactInput,
  CompactResult,
  PrecipitateResult,
  SearchOptions,
  SearchResultItem,
  SearchResult,
  SeedInput,
  SeedResult,
  SkillExtractResult,
  Source,
  Stats,
  Trace,
  TraceId,
  Unit,
  UnitId,
  UnitNode,
  UnitSource,
  UnitSummary,
  Version,
  WorkingMemory,
  NewAsset,
} from './domain.js';
import type { Storage } from './store.js';
import type { Embedder } from './embedder.js';
import { createEmbedder } from './embedder.js';
import type { LlmClient } from './llm.js';
import { createLlm } from './llm.js';
import { classifyUnitRuleBased, classifyUnits, type ClassifyReport } from './classify.js';
import { AmemError, unitNotFound } from './errors.js';
import { distillUnits } from './distill.js';
import { extractScenesFromTranscript } from './scenes.js';
import { generateLinks } from './linkgen.js';
import { recall } from './recall.js';
import { layeredRecall } from './layeredRecall.js';
import { refreshLayers } from './layers.js';
import { assetContentChanged, extractSkills } from './skills.js';
import { extractCodegraph } from './codegraph.js';
import { extractWiki } from './wiki.js';
import {
  importCodebase as importCodebaseFn,
  importDirectory as importDirectoryFn,
  importSessions as importSessionsFn,
  type ImporterDeps,
} from './importer.js';
import { consolidate } from './consolidate.js';
import { buildWorkingMemory } from './workingMemory.js';
import { routeAssets as routeAssetsFn } from './route.js';
import { countTokens } from './lib/tokenizer.js';
import { cosine } from './lib/vector.js';
import { newId, nowIso, snapshotOf, toUnitSummary } from './lib/util.js';
import { detectCommunities, countCommunities, type CommunityEdge } from './lib/communities.js';

export interface ServiceDeps {
  llm?: LlmClient;
  embed?: Embedder;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'did', 'was']);

/** CJK-aware keyword terms: latin words + individual CJK chars (bigram not needed for matching). */
function searchTerms(query: string): string[] {
  const latin = query
    .toLowerCase()
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
  const cjk = query.match(/[\u4e00-\u9fff]/g) ?? [];
  const cjkChars = [...new Set(cjk)];
  const terms = [...latin, ...cjkChars.map((c) => c)];
  // Keep only terms with at least one meaningful char.
  return terms.filter((t) => /[a-z0-9\u4e00-\u9fff]/i.test(t));
}

/**
 * Field-weighted keyword score (title > tags > summary > body head).
 * Returns score in 0..1 plus the terms that matched (for UI highlighting).
 */
function keywordScore(
  query: string,
  unit: Unit,
  opts: { fullText?: boolean } = {},
): { score: number; terms: string[] } {
  const terms = searchTerms(query);
  if (terms.length === 0) return { score: 0, terms: [] };
  const hay = opts.fullText ? unit.body : unit.body.slice(0, 500);
  const fields: Array<[string, number]> = [
    [unit.title, 3],
    [unit.tags.join(' '), 2],
    [unit.summary, 1.5],
    [hay, 1],
  ];
  const lower = fields.map(([text, w]) => [text.toLowerCase(), w] as const);
  let total = 0;
  const matched: string[] = [];
  for (const t of terms) {
    let fieldHits = 0;
    for (const [text, w] of lower) if (text.includes(t)) fieldHits += w;
    if (fieldHits > 0) {
      total += fieldHits;
      matched.push(t);
    }
  }
  const max = terms.length * (3 + 2 + 1.5 + 1);
  return { score: max > 0 ? total / max : 0, terms: matched };
}

/**
 * Cluster units by graph community (label propagation over cross-links),
 * naming each community after its dominant tag when one exists.
 */
function clusterNodes(units: Unit[], edges: CommunityEdge[]): NodeCluster[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const community = detectCommunities(
    units.map((u) => u.id),
    edges,
  );
  const members = new Map<string, UnitId[]>();
  for (const [id, c] of community) {
    const list = members.get(c) ?? [];
    list.push(id);
    members.set(c, list);
  }
  const clusters: NodeCluster[] = [];
  let n = 0;
  const usedLabels = new Set<string>();
  for (const [c, unitIds] of [...members.entries()].sort((a, b) => b[1].length - a[1].length)) {
    // Singletons are not meaningful communities for clustering purposes.
    if (unitIds.length < 2) continue;
    const tagCounts = new Map<string, number>();
    for (const id of unitIds) {
      for (const tag of byId.get(id)?.tags ?? []) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    let base = '';
    let labelCount = 0;
    for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (count > labelCount) {
        base = tag;
        labelCount = count;
      }
    }
    n++;
    let label = base || `Community ${n}`;
    if (usedLabels.has(label)) {
      let suffix = 2;
      while (usedLabels.has(`${label} #${suffix}`)) suffix++;
      label = `${label} #${suffix}`;
    }
    usedLabels.add(label);
    clusters.push({ id: `community:${c}`, label, unitIds });
  }
  return clusters;
}

export function createService(
  config: AmemConfig,
  storage: Storage,
  deps?: ServiceDeps,
): Promise<AmemService> {
  const make = async (): Promise<AmemService> => {
    let embed: Embedder = deps?.embed ?? (await createEmbedder(config.embedding));
    let llm: LlmClient = deps?.llm ?? createLlm(config.llm);

    let tokensSavedByDedup = 0;
    let recallTokensDelivered = 0;
    let tokenWasteAvoided = 0;
    let layersRefreshBusy = false;
    let lastAutoPrecipitateAt = 0;

    const emitActivity = async (
      kind: string,
      summary: string,
      meta?: Record<string, unknown>,
      actor = 'amem',
    ): Promise<void> => {
      try {
        await storage.recordEvent({ kind, summary, actor, meta });
      } catch {
        // activity is best-effort; never break the primary path
      }
    };

    const computeEmbedding = async (text: string): Promise<Unit['embedding']> => {
      const values = await embed.embed(text);
      return { dims: values.length, values };
    };

    const saveUnitInner = async (unit: NewUnit): Promise<Unit> => {
      const existing = unit.id ? await storage.getUnit(unit.id) : null;
      const now = nowIso();
      const embedding =
        unit.embedding ??
        (await computeEmbedding([unit.title, unit.summary ?? '', unit.body ?? ''].filter(Boolean).join(' ')));
      const labels = { ...(unit.labels ?? {}) };
      // Deterministic auto-classification keeps every new unit organized
      // without waiting for a batch classify pass.
      if (typeof labels.category !== 'string' || !labels.category) {
        labels.category = classifyUnitRuleBased({
          type: unit.type,
          title: unit.title,
          tags: unit.tags ?? [],
          labels,
        });
      }
      const full: Unit = {
        id: unit.id ?? newId('unit'),
        type: unit.type,
        form: unit.form ?? 'unit',
        title: unit.title,
        summary: unit.summary ?? '',
        body: unit.body ?? '',
        tags: unit.tags ?? [],
        labels,
        status: unit.status ?? 'pending',
        quality: unit.quality ?? 0.8,
        confidence: unit.confidence ?? 0.7,
        embedding,
        createdAt: unit.createdAt ?? now,
        validFrom: unit.validFrom,
        validTo: unit.validTo,
        sourceCount: unit.sourceCount ?? 0,
        importance: unit.importance ?? 0.5,
        decay: unit.decay ?? 1,
        version: unit.version ?? 1,
        updatedAt: now,
      };
      const version: Version = {
        id: newId('ver'),
        unitId: full.id,
        version: full.version,
        snapshot: snapshotOf(existing ?? full),
        reason: existing ? 'saveUnit' : 'create',
        createdAt: now,
      };
      if (existing) {
        full.version = existing.version + 1;
        version.version = full.version;
        version.snapshot = snapshotOf(existing);
        await storage.updateUnit(full);
      } else {
        await storage.createUnit(full);
      }
      await storage.createVersion(version);
      return full;
    };

    interface IngestCore {
      trace: Trace;
      units: Unit[];
      deduplicated: Array<{ candidateTitle: string; matchedUnitId: UnitId }>;
      tokensSaved: number;
      scenes?: IngestResult['scenes'];
      source?: Source;
    }

    /**
     * Shared ingest pipeline: trace + distillation + linking + scenes + job/activity.
     * Used by `ingest` (with optional auto-precipitation) and `compact` (offload).
     */
    const runIngest = async (input: IngestInput): Promise<IngestCore> => {
      const title =
        input.title?.trim() ||
        (input.content.split('\n').find((l) => l.trim())?.trim().slice(0, 80) ?? 'Untitled ingest');
      const trace: Trace = {
        id: newId('trace'),
        sessionId: input.sessionId,
        title,
        content: input.content,
        contentType: input.contentType ?? 'text/markdown',
        tokenCount: countTokens(input.content),
        createdAt: nowIso(),
      };
      if (input.sessionId) {
        await storage.upsertSession({ id: input.sessionId, label: input.sessionId });
      }
      await storage.createTrace(trace);

      let source: Source | undefined;
      if (input.sourceUri) {
        source = await storage.upsertSource({
          id: newId('src'),
          uri: input.sourceUri,
          title,
          kind: input.sourceKind ?? 'note',
          contentHash: '',
          contentLength: input.content.length,
          createdAt: nowIso(),
        });
      }

      const units: Unit[] = [];
      let deduplicated: Array<{ candidateTitle: string; matchedUnitId: UnitId }> = [];
      let tokensSaved = 0;
      const shouldExtract = input.extract ?? true;
      if (shouldExtract) {
        const result = await distillUnits(llm, embed, input.content, storage, config);
        deduplicated = result.deduplicated;
        tokensSaved = result.tokensSavedByDedup;
        tokensSavedByDedup += tokensSaved;
        for (const cand of result.units) {
          const unit = await saveUnitInner({
            type: cand.type,
            form: 'unit',
            title: cand.title,
            summary: cand.summary,
            body: cand.body,
            tags: cand.tags,
            labels: {},
            status: input.autoReview ? 'reviewed' : 'pending',
            quality: cand.quality,
            confidence: 0.7,
            importance: 0.5,
            decay: 1,
          });
          units.push(unit);
          if (source) {
            await storage.addCitation({
              unitId: unit.id,
              sourceId: source.id,
              span: cand.body.slice(0, 200),
              assertedAt: nowIso(),
            });
          }
        }
      }

      if (input.autoLink ?? true) {
        await generateLinks(storage, embed, config);
      }

      // Scene continuity: segment the transcript into heat-tracked L2 scenes.
      // Best-effort — never break the ingest path on scene failures.
      let scenes: IngestResult['scenes'];
      try {
        scenes = await extractScenesFromTranscript(storage, config, input.content);
      } catch {
        scenes = undefined;
      }

      await storage.recordJob({
        kind: 'ingest',
        status: 'done',
        meta: { trace: trace.id, units: units.length, source: source?.id },
      });

      return { trace, units, deduplicated, tokensSaved, scenes, source };
    };

    const service: AmemService = {
      async ingest(input: IngestInput): Promise<IngestResult> {
        const { trace, units, deduplicated, tokensSaved, scenes } = await runIngest(input);
        await emitActivity(
          'ingest',
          `Ingested "${trace.title}" → ${units.length} unit(s)`,
          {
            traceId: trace.id,
            unitIds: units.map((u) => u.id),
            unitTitles: units.map((u) => u.title),
            deduplicated,
            tokensSaved,
            sessionId: input.sessionId,
            scenes,
          },
        );

        // Auto-precipitate assets (scenarios/skills/codegraph/wiki) when enabled.
        const ap = config.autoPrecipitate;
        if (ap?.enabled && units.length > 0) {
          const now = Date.now();
          if (now - lastAutoPrecipitateAt >= (ap.minIntervalMs ?? 60_000)) {
            lastAutoPrecipitateAt = now;
            try {
              await service.autoPrecipitate({ mode: ap.mode ?? 'fast' });
            } catch {
              // precipitation is best-effort; never break the ingest path
            }
          }
        }

        return { trace, units, deduplicated, tokensSavedByDedup: tokensSaved, scenes };
      },

      async compact(input: CompactInput): Promise<CompactResult> {
        const content =
          input.content?.trim() ||
          (input.messages ?? [])
            .filter((m) => typeof m.content === 'string' && m.content.trim())
            .map((m) => `${m.role}: ${m.content.trim()}`)
            .join('\n');
        if (!content) {
          throw new AmemError('VALIDATION', 'compact requires messages or content');
        }
        const inputTokens = countTokens(content);
        const { trace, units, deduplicated } = await runIngest({
          title: `Offload ${input.sessionId ?? 'conversation'}`,
          content,
          contentType: 'text/plain',
          sessionId: input.sessionId,
          sourceUri: input.sessionId ? `session://${input.sessionId}` : undefined,
          sourceKind: 'transcript',
          extract: true,
          autoLink: input.autoLink ?? false,
          autoReview: false,
        });

        const budget = Math.max(50, input.budget ?? 300);
        const lines: string[] = [];
        let used = 0;
        for (const u of units) {
          const line = `- [${u.type}] ${u.title} (${u.id}) — ${u.summary || u.body.slice(0, 120)}`;
          const approx = Math.ceil(line.length / 4);
          if (used + approx > budget) break;
          lines.push(line);
          used += approx;
        }
        const replacement = [
          `[amem:offload] Offloaded ${input.messages?.length ?? 1} message(s) (~${inputTokens} tokens) to Amem. Trace: ${trace.id}.`,
          ...lines,
          'Details: use recall with these keywords instead of the raw transcript.',
        ].join('\n');

        const outputTokens = countTokens(replacement);
        await emitActivity(
          'compact',
          `Offloaded ${inputTokens} tokens → ${units.length} unit(s), replacement ${outputTokens} tokens`,
          {
            traceId: trace.id,
            unitIds: units.map((u) => u.id),
            inputTokens,
            outputTokens,
            tokensSaved: Math.max(0, inputTokens - outputTokens),
            sessionId: input.sessionId,
          },
        );

        return {
          trace,
          units,
          replacement,
          inputTokens,
          outputTokens,
          tokensSaved: Math.max(0, inputTokens - outputTokens),
          deduplicated,
        };
      },

      async recall(input: RecallInput): Promise<RecallResult> {
        const result = await recall(storage, embed, config, input);
        recallTokensDelivered += result.usedTokens;
        tokenWasteAvoided += Math.max(0, result.budget - result.usedTokens);
        await emitActivity(
          'recall',
          `Recalled ${result.items.length} unit(s) for "${input.query.slice(0, 80)}"`,
          {
            query: input.query,
            usedTokens: result.usedTokens,
            budget: result.budget,
            unitIds: result.items.map((i) => i.unit.id),
            unitTitles: result.items.map((i) => i.unit.title),
          },
        );
        return result;
      },

      async recallLayered(input: RecallInput): Promise<LayeredRecallResult> {
        const result = await layeredRecall(storage, embed, config, input);
        recallTokensDelivered += result.usedTokens;
        tokenWasteAvoided += Math.max(0, result.budget - result.usedTokens);
        await emitActivity(
          'recall',
          `Layered recall: ${result.scenarios.length} scenario(s) + ${result.units.length} unit(s) for "${input.query.slice(0, 80)}"`,
          {
            query: input.query,
            usedTokens: result.usedTokens,
            budget: result.budget,
            scenarioIds: result.scenarios.map((s) => s.scenario.id),
            scenarioTitles: result.scenarios.map((s) => s.scenario.title),
            unitIds: result.units.map((i) => i.unit.id),
            unitTitles: result.units.map((i) => i.unit.title),
            personaVersion: result.persona?.version,
          },
        );
        return result;
      },

      async search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
        const limit = opts.limit ?? 10;
        const queryVec = await embed.embed(query);
        const all = await storage.allUnitsWithEmbeddings();
        const active = all.filter((u) => {
          if (u.status === 'archived') return false;
          if (opts.status && u.status !== opts.status) return false;
          if (opts.type && u.type !== opts.type) return false;
          if (opts.category && u.labels?.category !== opts.category) return false;
          if (opts.tag && !u.tags.includes(opts.tag)) return false;
          return true;
        });
        const scored = active.map((unit) => {
          let score = 0;
          let semantic = 0;
          let terms: string[] = [];
          if (unit.embedding) {
            semantic = Math.max(0, cosine(queryVec, unit.embedding.values));
            score += semantic * 0.5;
          }
          const kw = keywordScore(query, unit, opts);
          terms = kw.terms;
          score += kw.score * 0.5;
          const via: SearchResult['items'][number]['via'] =
            semantic > 0.05 && kw.score > 0 ? 'hybrid' : semantic > 0.05 ? 'semantic' : kw.score > 0 ? 'keyword' : 'hybrid';
          return { unit, score, via, terms, kwScore: kw.score };
        });
        scored.sort((a, b) => b.score - a.score);
        // Keyword hits always surface before semantic-only matches so exact
        // term matches are never drowned out by noisy semantic similarity.
        const keywordHits = scored.filter((t) => t.kwScore > 0);
        const semanticOnly = scored.filter((t) => t.kwScore === 0);
        // Within keyword hits rank by keyword score first (more matched terms
        // win) so a full title match outranks a single shared character.
        keywordHits.sort((a, b) => b.kwScore - a.kwScore || b.score - a.score);
        const items: SearchResultItem[] = [...keywordHits, ...semanticOnly].slice(0, limit).map((t) => ({
          unit: toUnitSummary(t.unit),
          score: t.score,
          via: t.via,
          terms: t.terms,
        }));
        await emitActivity(
          'search',
          `Search "${query.slice(0, 80)}" → ${items.length} hit(s)`,
          {
            query,
            limit,
            unitIds: items.map((i) => i.unit.id),
            unitTitles: items.map((i) => i.unit.title),
          },
        );
        return { query, items };
      },

      async saveUnit(unit: NewUnit): Promise<Unit> {
        const saved = await saveUnitInner(unit);
        await emitActivity(
          'save_unit',
          `Saved unit "${saved.title}" (${saved.type})`,
          { unitId: saved.id, type: saved.type, status: saved.status },
        );
        return saved;
      },

      async getUnit(id: UnitId): Promise<Unit | null> {
        return storage.getUnit(id);
      },

      async updateUnit(id: UnitId, patch: Partial<NewUnit>, reason = 'update'): Promise<Unit> {
        const existing = await storage.getUnit(id);
        if (!existing) throw unitNotFound(id);
        const now = nowIso();
        const next: Unit = {
          ...existing,
          ...patch,
          id: existing.id,
          version: existing.version + 1,
          updatedAt: now,
          sourceCount: patch.sourceCount ?? existing.sourceCount,
          embedding: patch.embedding ?? existing.embedding,
        };
        if (patch.title !== undefined || patch.summary !== undefined || patch.body !== undefined || !next.embedding) {
          next.embedding = await computeEmbedding([next.title, next.summary, next.body].filter(Boolean).join(' '));
        }
        await storage.createVersion({
          id: newId('ver'),
          unitId: id,
          version: next.version,
          snapshot: snapshotOf(existing),
          reason,
          createdAt: now,
        });
        await storage.updateUnit(next);
        await emitActivity(
          'update_unit',
          `Updated unit "${next.title}"`,
          { unitId: next.id, reason, version: next.version },
        );
        return next;
      },

      async deleteUnit(id: UnitId): Promise<void> {
        if (!(await storage.getUnit(id))) throw unitNotFound(id);
        await storage.deleteUnit(id);
      },

      async reviewUnit(id: UnitId, action: 'accept' | 'discard'): Promise<Unit | null> {
        const existing = await storage.getUnit(id);
        if (!existing) throw unitNotFound(id);
        if (action === 'accept') {
          const updated = await service.updateUnit(id, { status: 'reviewed' }, 'review-accept');
          await emitActivity('review', `Accepted unit "${existing.title}"`, { unitId: id, action });
          return updated;
        }
        await storage.deleteUnit(id);
        await emitActivity('review', `Discarded unit "${existing.title}"`, { unitId: id, action });
        return null;
      },

      async listUnits(filter: {
        type?: Unit['type'];
        status?: Unit['status'];
        tag?: string;
        category?: string;
        limit?: number;
        offset?: number;
      } = {}): Promise<UnitSummary[]> {
        const all = await storage.allUnitsWithEmbeddings();
        let list = all.map(toUnitSummary);
        if (filter.type) list = list.filter((u) => u.type === filter.type);
        if (filter.status) list = list.filter((u) => u.status === filter.status);
        if (filter.tag) list = list.filter((u) => u.tags.includes(filter.tag!));
        if (filter.category) list = list.filter((u) => u.category === filter.category);
        list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
        const offset = filter.offset ?? 0;
        const limit = filter.limit ?? list.length;
        return list.slice(offset, offset + limit);
      },

      async classifyUnits(
        opts: { ids?: string[]; mode?: 'rules' | 'llm' | 'auto'; reclassify?: boolean } = {},
      ): Promise<ClassifyReport> {
        const all = await storage.allUnitsWithEmbeddings();
        const report = await classifyUnits(llm, all, opts);
        // Persist label updates; keep activity to one summary event.
        let changed = 0;
        for (const u of all) {
          const category = u.labels?.category;
          if (typeof category !== 'string' || !category) continue;
          const existing = await storage.getUnit(u.id);
          if (existing && String(existing.labels?.category ?? '') !== category) {
            await storage.updateUnit({
              ...existing,
              labels: { ...(existing.labels ?? {}), category },
              version: existing.version + 1,
              updatedAt: nowIso(),
            });
            changed += 1;
          }
        }
        await emitActivity(
          'classify',
          `Classified ${report.classified} unit(s) — ${Object.entries(report.byCategory)
            .map(([c, n]) => `${c}:${n}`)
            .join(' ')}`,
          { ...report, persisted: changed },
        );
        return { ...report, persisted: changed };
      },

      async batchUnits(opts: { ids: string[]; action: 'archive' | 'restore' | 'delete' | 'accept' }): Promise<{ affected: number; skipped: number }> {
        let affected = 0;
        let skipped = 0;
        for (const id of opts.ids) {
          const existing = await storage.getUnit(id);
          if (!existing || existing.status === 'merged') {
            skipped += 1;
            continue;
          }
          if (opts.action === 'delete') {
            await storage.deleteUnit(id);
            affected += 1;
            continue;
          }
          const nextStatus =
            opts.action === 'archive'
              ? ('archived' as const)
              : opts.action === 'accept' || opts.action === 'restore'
                ? ('reviewed' as const)
                : ('pending' as const);
          if (existing.status === nextStatus) {
            skipped += 1;
            continue;
          }
          await storage.updateUnit({
            ...existing,
            status: nextStatus,
            version: existing.version + 1,
            updatedAt: nowIso(),
          });
          affected += 1;
        }
        await emitActivity(
          'batch_units',
          `Batch ${opts.action}: ${affected} affected, ${skipped} skipped`,
          { action: opts.action, ids: opts.ids.length },
        );
        return { affected, skipped };
      },

      async getGraph(includeClusters = false, includeScenarios = false): Promise<Graph> {
        const all = await storage.allUnitsWithEmbeddings();
        const links = await storage.allLinks();
        const degreeMap = new Map<string, number>();
        for (const l of links) {
          degreeMap.set(l.sourceUnitId, (degreeMap.get(l.sourceUnitId) ?? 0) + 1);
          degreeMap.set(l.targetUnitId, (degreeMap.get(l.targetUnitId) ?? 0) + 1);
        }
        const nodes: UnitNode[] = all.map((u) => ({
          ...toUnitSummary(u),
          quality: u.quality,
          confidence: u.confidence,
          degree: degreeMap.get(u.id) ?? 0,
        }));
        const nodeIds = new Set(nodes.map((n) => n.id));
        // Drop dangling edges (e.g. links to archived units) so the force graph renders cleanly.
        let graphLinks: Graph['links'] = links
          .filter((l) => nodeIds.has(l.sourceUnitId) && nodeIds.has(l.targetUnitId))
          .map((l) => ({
            id: l.id,
            sourceUnitId: l.sourceUnitId,
            targetUnitId: l.targetUnitId,
            relation: l.relation,
            confidence: l.confidence,
            auto: l.auto,
          }));
        if (includeScenarios) {
          // Hot-scene navigation: overlay L2 scenarios as graph nodes wired to
          // their source units, so recall heat is visible and navigable.
          const scenarios = await storage.listScenarios({ status: 'active' });
          const unitIds = new Set(nodes.map((n) => n.id));
          for (const s of scenarios) {
            nodes.push({
              id: s.id,
              type: 'concept',
              form: 'crystal',
              title: s.title,
              summary: s.summary,
              tags: s.tags,
              importance: 0.9,
              decay: 1,
              status: 'reviewed',
              updatedAt: s.updatedAt,
              quality: 0.9,
              confidence: 0.9,
              degree: 0,
              isScenario: true,
              heat: s.heat,
            });
            for (const uid of s.sourceUnitIds) {
              if (unitIds.has(uid)) {
                graphLinks.push({
                  id: `${s.id}:${uid}`,
                  sourceUnitId: s.id,
                  targetUnitId: uid,
                  relation: 'references',
                  confidence: 1,
                  auto: true,
                });
              }
            }
          }
        }
        // Rendering guard: cap weak `related_to` edges per node so the force
        // layout stays readable even when historical auto-linking over-connected
        // the graph. Typed relations (supports/part_of/...) always survive.
        const MAX_RELATED_PER_NODE = 12;
        {
          const keep = new Set<string>();
          const byNode = new Map<string, { id: string; confidence: number }[]>();
          for (const l of graphLinks) {
            if (l.relation !== 'related_to') {
              keep.add(l.id);
              continue;
            }
            for (const uid of [l.sourceUnitId, l.targetUnitId]) {
              const list = byNode.get(uid) ?? [];
              list.push({ id: l.id, confidence: l.confidence });
              byNode.set(uid, list);
            }
          }
          for (const list of byNode.values()) {
            list.sort(
              (p, q) => q.confidence - p.confidence || p.id.localeCompare(q.id),
            );
            for (const { id } of list.slice(0, MAX_RELATED_PER_NODE)) keep.add(id);
          }
          const kept = new Set(keep);
          graphLinks = graphLinks.filter((l) => kept.has(l.id));
        }
        // Recompute degree on visible graph only.
        const visibleDegree = new Map<string, number>();
        for (const l of graphLinks) {
          visibleDegree.set(l.sourceUnitId, (visibleDegree.get(l.sourceUnitId) ?? 0) + 1);
          visibleDegree.set(l.targetUnitId, (visibleDegree.get(l.targetUnitId) ?? 0) + 1);
        }
        for (const n of nodes) n.degree = visibleDegree.get(n.id) ?? 0;
        const clusters = includeClusters ? clusterNodes(all, graphLinks) : undefined;
        if (clusters) {
          const byUnit = new Map<string, NodeCluster>();
          for (const c of clusters) for (const id of c.unitIds) byUnit.set(id, c);
          for (const n of nodes) {
            const c = byUnit.get(n.id);
            if (c) {
              n.community = c.id;
              n.communityLabel = c.label;
            }
          }
        }
        return { nodes, links: graphLinks, clusters };
      },

      async linkUnits(input: {
        sourceUnitId: UnitId;
        targetUnitId: UnitId;
        relation: LinkRelation;
        reason?: string;
        auto?: boolean;
      }): Promise<Link> {
        const a = await storage.getUnit(input.sourceUnitId);
        const b = await storage.getUnit(input.targetUnitId);
        if (!a || !b) throw unitNotFound(!a ? input.sourceUnitId : input.targetUnitId);
        const link: Link = {
          id: newId('link'),
          sourceUnitId: input.sourceUnitId,
          targetUnitId: input.targetUnitId,
          relation: input.relation,
          reason: input.reason ?? `manual link: ${input.relation}`,
          confidence: 1,
          auto: input.auto ?? false,
          createdAt: nowIso(),
        };
        await storage.upsertLink(link);
        await emitActivity(
          'link',
          `Linked ${a.title} —${input.relation}→ ${b.title}`,
          { linkId: link.id, sourceUnitId: link.sourceUnitId, targetUnitId: link.targetUnitId, relation: link.relation },
        );
        return link;
      },

      async getLinksForUnit(unitId: UnitId): Promise<Link[]> {
        return storage.getLinksForUnit(unitId);
      },

      async pruneAutoLinks(opts: { maxPerUnit?: number; dryRun?: boolean } = {}): Promise<{
        examined: number;
        kept: number;
        deleted: number;
      }> {
        const maxPerUnit = Math.max(1, opts.maxPerUnit ?? config.thresholds.maxLinksPerUnit ?? 8);
        const all = await storage.allLinks();
        const auto = all.filter((l) => l.auto);
        const strongRelation = (r: LinkRelation): number => (r === 'related_to' ? 1 : 0);
        const rank = (p: Link, q: Link): number =>
          q.confidence - p.confidence ||
          strongRelation(p.relation) - strongRelation(q.relation) ||
          p.createdAt.localeCompare(q.createdAt);
        // Greedy global ranking with a strict per-unit degree cap: walk auto
        // links from strongest to weakest and keep a link only while neither
        // endpoint is already at its cap. Guarantees every unit ends at
        // <= maxPerUnit auto links and keeps its highest-confidence neighbors.
        const sorted = [...auto].sort(rank);
        const degree = new Map<string, number>();
        const keep = new Set<string>();
        for (const l of sorted) {
          const ds = degree.get(l.sourceUnitId) ?? 0;
          const dt = degree.get(l.targetUnitId) ?? 0;
          if (ds >= maxPerUnit || dt >= maxPerUnit) continue;
          keep.add(l.id);
          degree.set(l.sourceUnitId, ds + 1);
          degree.set(l.targetUnitId, dt + 1);
        }
        const toDelete = auto.filter((l) => !keep.has(l.id)).map((l) => l.id);
        if (!opts.dryRun && toDelete.length > 0) await storage.deleteLinks(toDelete);
        return { examined: auto.length, kept: keep.size, deleted: toDelete.length };
      },

      async workingMemory(date?: string, budget?: number): Promise<WorkingMemory> {
        return buildWorkingMemory(storage, config, date ?? nowIso(), budget);
      },

      async listScenarios(filter: { tag?: string; status?: ScenarioStatus; limit?: number; sort?: 'updated' | 'heat' } = {}): Promise<Scenario[]> {
        return storage.listScenarios(filter);
      },

      async getScenario(id: ScenarioId): Promise<Scenario | null> {
        return storage.getScenario(id);
      },

      async refreshLayers(opts: { tags?: string[]; forcePersona?: boolean; maxScenarios?: number; mode?: 'fast' | 'auto' | 'full' } = {}): Promise<LayerRefreshResult> {
        if (layersRefreshBusy) {
          throw new AmemError('BUSY', 'A layers refresh is already in progress', { mode: opts.mode });
        }
        layersRefreshBusy = true;
        try {
          const [layerResult, skillResult] = await Promise.allSettled([
            refreshLayers(llm, storage, config, opts),
            extractSkills(llm, storage, { limit: 20, heuristic: opts.mode === 'fast' }),
          ]);
          const layer = layerResult.status === 'fulfilled'
            ? layerResult.value
            : {
                scenariosCreated: 0,
                scenariosUpdated: 0,
                personaUpdated: false,
                skillsExtracted: 0,
                skillsCreated: 0,
                skillsUpdated: 0,
                unitsCovered: 0,
              };
          const skill = skillResult.status === 'fulfilled'
            ? skillResult.value
            : { created: 0, updated: 0 };
          const result: LayerRefreshResult = {
            ...layer,
            skillsExtracted: skill.created + skill.updated,
            skillsCreated: skill.created,
            skillsUpdated: skill.updated,
          };
          await emitActivity(
            'refresh_layers',
            `Refreshed L2/L3 (${opts.mode ?? 'auto'}): +${result.scenariosCreated} scenario(s), ${result.scenariosUpdated} updated, persona ${result.personaUpdated ? 'updated' : 'unchanged'}, +${result.skillsCreated} skill(s)`,
            { ...result, mode: opts.mode ?? 'auto' },
          );
          return result;
        } finally {
          layersRefreshBusy = false;
        }
      },

      async getPersona(): Promise<Persona | null> {
        return storage.getPersona();
      },

      async listAssets(filter: { kind?: AssetKind; status?: AssetStatus; limit?: number } = {}): Promise<Asset[]> {
        return storage.listAssets(filter);
      },

      async getAsset(id: AssetId): Promise<Asset | null> {
        return storage.getAsset(id);
      },

      async listAssetVersions(id: AssetId): Promise<AssetVersion[]> {
        return storage.listAssetVersions(id);
      },

      async saveAsset(asset: NewAsset): Promise<Asset> {
        const now = nowIso();
        const existing = asset.id ? await storage.getAsset(asset.id) : null;
        const contentChanged = existing ? assetContentChanged(existing, {
          ...existing,
          ...asset,
          id: existing.id,
        }) : true;
        const full: Asset = {
          id: asset.id ?? newId('asset'),
          kind: asset.kind,
          name: asset.name,
          description: asset.description,
          content: asset.content,
          body: asset.body,
          trigger: asset.trigger,
          tags: asset.tags ?? [],
          sourceUnitIds: asset.sourceUnitIds ?? [],
          status: asset.status ?? 'draft',
          visibility: asset.visibility ?? 'workspace',
          boundAgents: asset.boundAgents ?? [],
          // Version = content version. Pure metadata/provenance edits keep the
          // number stable so every version has a matching snapshot.
          version: existing ? (contentChanged ? existing.version + 1 : existing.version) : (asset.version ?? 1),
          createdAt: existing?.createdAt ?? asset.createdAt ?? now,
          updatedAt: now,
        };
        if (existing) {
          if (contentChanged) await storage.snapshotAssetVersion(existing, 'save-asset: content changed');
          await storage.updateAsset(full);
        } else {
          await storage.createAsset(full);
        }
        await emitActivity(
          'asset',
          `${existing ? 'Updated' : 'Saved'} ${full.kind} asset "${full.name}"`,
          { assetId: full.id, kind: full.kind, status: full.status },
        );
        return full;
      },

      async updateAsset(id: AssetId, patch: Partial<NewAsset>, reason = 'update'): Promise<Asset> {
        const existing = await storage.getAsset(id);
        if (!existing) throw new Error(`asset not found: ${id}`);
        const next: Asset = {
          ...existing,
          ...patch,
          id: existing.id,
          version: assetContentChanged(existing, { ...existing, ...patch, id: existing.id })
            ? existing.version + 1
            : existing.version,
          updatedAt: nowIso(),
        };
        if (assetContentChanged(existing, next)) {
          await storage.snapshotAssetVersion(existing, reason || 'update');
        }
        await storage.updateAsset(next);
        await emitActivity('asset', `Updated ${next.kind} asset "${next.name}" (${reason})`, {
          assetId: next.id,
          kind: next.kind,
          reason,
        });
        return next;
      },

      async deleteAsset(id: AssetId): Promise<void> {
        await storage.deleteAsset(id);
      },

      async listEquipped(agent: string): Promise<Asset[]> {
        return storage.listEquipped(agent);
      },

      async routeAssets(input: RouteAssetsInput): Promise<AssetRouteResult> {
        const out = await routeAssetsFn(storage, input);
        await emitActivity(
          'asset_route',
          `Routed "${input.task.slice(0, 80)}" -> ${out.items.length} asset(s)`,
          {
            query: input.task.slice(0, 200),
            agent: input.agent,
            kind: input.kind,
            top: out.items.slice(0, 3).map((i) => i.asset.name),
            usedTokens: out.usedTokens,
          },
        );
        return out;
      },

      async callAsset(input: {
        id: AssetId;
        agent?: string;
        query?: string;
        budget?: number;
      }): Promise<AssetCallResult> {
        const asset = await storage.getAsset(input.id);
        if (!asset) throw new AmemError('NOT_FOUND', `Asset not found: ${input.id}`);
        if (asset.status !== 'published') {
          throw new AmemError('FORBIDDEN', `Asset "${asset.name}" is not published`);
        }
        const agent = input.agent ?? 'unknown';
        const allowed =
          asset.visibility === 'public' ||
          asset.visibility === 'workspace' ||
          asset.boundAgents.includes(agent);
        if (!allowed) {
          throw new AmemError('FORBIDDEN', `Agent "${agent}" is not bound to asset "${asset.name}"`);
        }
        const budget = input.budget ?? config.thresholds.recallBudget ?? 2000;
        const fullBody = asset.body || asset.content || '';
        const fullTokens = countTokens(fullBody);
        const body =
          fullTokens > budget
            ? `${fullBody.slice(0, budget * 4)}…\n\n[truncated: ${fullTokens} tokens > budget ${budget}; call with a larger budget to read more]`
            : fullBody;
        const usedTokens = Math.min(fullTokens, budget);
        await emitActivity(
          'asset_call',
          `Agent "${agent}" called asset "${asset.name}"${input.query ? ` (query: ${input.query.slice(0, 80)})` : ''}`,
          {
            assetId: asset.id,
            kind: asset.kind,
            agent,
            query: input.query?.slice(0, 200),
            usedTokens,
            budget,
          },
        );
        return {
          assetId: asset.id,
          kind: asset.kind,
          name: asset.name,
          trigger: asset.trigger,
          body,
          version: asset.version,
          usedTokens,
          budget,
          truncated: fullTokens > budget,
        };
      },

      async extractSkills(opts: { limit?: number; includePending?: boolean } = {}): Promise<SkillExtractResult> {
        const result = await extractSkills(llm, storage, opts);
        await emitActivity(
          'extract_skills',
          `Extracted skills: +${result.created} created, ${result.updated} updated`,
          { created: result.created, updated: result.updated },
        );
        return result;
      },

      async extractCodegraph(opts: { limit?: number } = {}): Promise<AssetExtractResult> {
        const result = await extractCodegraph(storage, opts);
        await emitActivity(
          'extract_codegraph',
          `Extracted code graph: +${result.created} created, ${result.updated} updated`,
          { created: result.created, updated: result.updated },
        );
        return result;
      },

      async extractWiki(opts: { limit?: number } = {}): Promise<AssetExtractResult> {
        const result = await extractWiki(storage, opts);
        await emitActivity(
          'extract_wiki',
          `Extracted wiki pages: +${result.created} created, ${result.updated} updated`,
          { created: result.created, updated: result.updated },
        );
        return result;
      },

      async autoPrecipitate(opts: { mode?: 'fast' | 'auto' | 'full' } = {}): Promise<PrecipitateResult> {
        if (layersRefreshBusy) {
          throw new AmemError('BUSY', 'A precipitation run is already in progress', { mode: opts.mode });
        }
        layersRefreshBusy = true;
        try {
          const mode = opts.mode ?? 'auto';
          const [layers, skills, codegraph, wiki] = await Promise.allSettled([
            refreshLayers(llm, storage, config, { mode }),
            extractSkills(llm, storage, { limit: 20, heuristic: mode === 'fast' }),
            extractCodegraph(storage),
            extractWiki(storage),
          ]);
          const layer =
            layers.status === 'fulfilled'
              ? layers.value
              : { scenariosCreated: 0, scenariosUpdated: 0, personaUpdated: false, skillsCreated: 0, skillsUpdated: 0, unitsCovered: 0 };
          const skill = skills.status === 'fulfilled' ? skills.value : { created: 0, updated: 0 };
          const cg = codegraph.status === 'fulfilled' ? codegraph.value : { created: 0, updated: 0 };
          const wk = wiki.status === 'fulfilled' ? wiki.value : { created: 0, updated: 0 };
          const result: PrecipitateResult = {
            mode,
            scenariosCreated: layer.scenariosCreated,
            scenariosUpdated: layer.scenariosUpdated,
            personaUpdated: layer.personaUpdated,
            skillsExtracted: skill.created + skill.updated,
            codegraphCreated: cg.created,
            codegraphUpdated: cg.updated,
            wikiCreated: wk.created,
            wikiUpdated: wk.updated,
          };
          await emitActivity(
            'precipitate',
            `Auto-precipitated (${mode}): +${result.skillsExtracted} skill(s), ${result.codegraphCreated}/${result.codegraphUpdated} codegraph, ${result.wikiCreated}/${result.wikiUpdated} wiki`,
            { ...result } as Record<string, unknown>,
          );
          return result;
        } finally {
          layersRefreshBusy = false;
        }
      },

      async importDirectory(input: ImportDirInput): Promise<ImportSourcesResult> {
        const deps: ImporterDeps = {
          storage,
          ingest: (i) => service.ingest(i),
          saveUnit: (u) => service.saveUnit(u),
          linkUnits: (l) => service.linkUnits({ ...l, auto: true }),
        };
        const before = (await storage.allLinks()).length;
        const result = await importDirectoryFn(deps, input);
        await generateLinks(storage, embed, config);
        const after = (await storage.allLinks()).length;
        result.links += Math.max(0, after - before);
        await emitActivity(
          'import_dir',
          `Imported directory ${input.path}: ${result.files} file(s) → ${result.units} unit(s)`,
          { ...result, path: input.path },
        );
        return result;
      },

      async importCodebase(input: ImportCodebaseInput): Promise<ImportSourcesResult> {
        const deps: ImporterDeps = {
          storage,
          ingest: (i) => service.ingest(i),
          saveUnit: (u) => service.saveUnit(u),
          linkUnits: (l) => service.linkUnits({ ...l, auto: true }),
        };
        const before = (await storage.allLinks()).length;
        const result = await importCodebaseFn(deps, input);
        await generateLinks(storage, embed, config);
        const after = (await storage.allLinks()).length;
        result.links += Math.max(0, after - before);
        await emitActivity(
          'import_codebase',
          `Indexed codebase ${input.path}: ${result.files} file(s) → ${result.units} unit(s)`,
          { ...result, path: input.path },
        );
        return result;
      },

      async importSessions(input: ImportSessionsInput): Promise<ImportSourcesResult> {
        const deps: ImporterDeps = {
          storage,
          ingest: (i) => service.ingest(i),
          saveUnit: (u) => service.saveUnit(u),
          linkUnits: (l) => service.linkUnits({ ...l, auto: true }),
        };
        const before = (await storage.allLinks()).length;
        const result = await importSessionsFn(deps, input);
        await generateLinks(storage, embed, config);
        const after = (await storage.allLinks()).length;
        result.links += Math.max(0, after - before);
        await emitActivity(
          'import_sessions',
          `Imported ${result.sessions} session(s) from ${input.path} → ${result.units} unit(s)`,
          { ...result, path: input.path },
        );
        return result;
      },

      async seed(input: SeedInput): Promise<SeedResult> {
        const out: SeedResult = {
          imported: null,
          docs: null,
          codebase: null,
          totalUnits: 0,
          precipitated: null,
          persona: null,
        };
        if (input.sessionsPath) {
          out.imported = await service.importSessions({
            path: input.sessionsPath,
            sessionLabel: input.sessionLabel,
            extract: true,
          });
          out.totalUnits += out.imported.units;
        }
        if (input.docsPath) {
          out.docs = await service.importDirectory({
            path: input.docsPath,
            extract: true,
          });
          out.totalUnits += out.docs.units;
        }
        if (input.codebasePath) {
          out.codebase = await service.importCodebase({
            path: input.codebasePath,
          });
          out.totalUnits += out.codebase.units;
        }
        if (out.totalUnits === 0) {
          throw new AmemError('VALIDATION', 'seed requires at least one of sessionsPath, docsPath, codebasePath');
        }
        if (input.precipitate ?? true) {
          out.precipitated = await service.autoPrecipitate({ mode: 'fast' });
        }
        if (input.persona ?? true) {
          await service.refreshLayers({ forcePersona: true, mode: 'fast' });
          out.persona = await service.getPersona();
        }
        await emitActivity(
          'seed',
          `Seeded workspace from sessions/docs/codebase → ${out.totalUnits} unit(s)`,
          {
            sessions: out.imported?.sessions ?? 0,
            docsFiles: out.docs?.files ?? 0,
            codeFiles: out.codebase?.files ?? 0,
            totalUnits: out.totalUnits,
          },
        );
        return out;
      },

      async forget(unitId: UnitId, reason = 'forget'): Promise<void> {
        const existing = await storage.getUnit(unitId);
        if (!existing) throw unitNotFound(unitId);
        await service.updateUnit(unitId, { status: 'archived', decay: 0 }, reason);
        await emitActivity('forget', `Forgot unit "${existing.title}"`, { unitId, reason });
      },

      async curate(preset?: 'fast' | 'full'): Promise<CurateReport> {
        // Link generation is offline/heuristic and cheap in both presets; only
        // skip it when no embedder is available.
        const report = await consolidate(storage, config, embed, undefined);
        await emitActivity(
          'curate',
          `Curated (${preset ?? 'full'}): +${report.linksCreated} links, ${report.linksPruned} pruned, ${report.crystalsPromoted} crystals, ${report.archived} archived`,
          { ...report, preset: preset ?? 'full' },
        );
        return report;
      },

      async stats(): Promise<Stats> {
        const counts = await storage.counts();
        const byType = await storage.byTypeCounts();
        const perDay = await storage.perDay(14);
        const all = await storage.allUnitsWithEmbeddings();
        const links = await storage.allLinks();
        const communityCount = countCommunities(
          detectCommunities(
            all.map((u) => u.id),
            links,
          ),
        );
        return {
          counts,
          byType,
          tokensSavedByDedup,
          recallTokensDelivered,
          tokenWasteAvoided,
          perDay,
          graph: { nodeCount: all.length, linkCount: links.length, communityCount },
        };
      },

      async activity(filter: ActivityFilter = {}): Promise<ActivityEvent[]> {
        return storage.listEvents(filter);
      },

      async getTraces(filter?: { sessionId?: string; limit?: number }): Promise<Trace[]> {
        return storage.listTraces(filter);
      },

      async getTrace(id: TraceId): Promise<Trace | null> {
        return storage.getTrace(id);
      },

      async import(payload: ExportBundle): Promise<ImportResult> {
        let units = 0;
        let traces = 0;
        let links = 0;
        let sources = 0;
        for (const unit of payload.units) {
          const existing = await storage.getUnit(unit.id);
          if (existing) await storage.updateUnit(unit);
          else await storage.createUnit(unit);
          units++;
        }
        for (const trace of payload.traces) {
          await storage.createTrace(trace);
          traces++;
        }
        for (const source of payload.sources) {
          await storage.upsertSource(source);
          sources++;
        }
        for (const citation of payload.unitSources) {
          await storage.addCitation(citation);
        }
        for (const link of payload.links) {
          await storage.upsertLink(link);
          links++;
        }
        let scenarios = 0;
        for (const scenario of payload.scenarios ?? []) {
          const existing = await storage.getScenario(scenario.id);
          if (existing) await storage.updateScenario(scenario);
          else await storage.createScenario(scenario);
          scenarios++;
        }
        let assets = 0;
        for (const asset of payload.assets ?? []) {
          const existing = await storage.getAsset(asset.id);
          if (existing) await storage.updateAsset(asset);
          else await storage.createAsset(asset);
          assets++;
        }
        if (payload.persona) {
          const existing = await storage.getPersona();
          await storage.upsertPersona({
            ...payload.persona,
            id: existing?.id ?? payload.persona.id,
            version: (existing?.version ?? payload.persona.version ?? 0) + 1,
            updatedAt: nowIso(),
          });
        }
        const result = { units, traces, links, sources };
        await emitActivity(
          'import',
          `Imported ${units} units / ${traces} traces / ${links} links / ${scenarios} scenarios / ${assets} assets`,
          { ...result, scenarios, assets },
        );
        return result;
      },

      async export(): Promise<ExportBundle> {
        const graph = await service.getGraph(false);
        const units = await storage.allUnitsWithEmbeddings();
        const links = await storage.allLinks();
        const traces = await storage.listTraces({});
        const scenarios = await storage.listScenarios({ limit: 1000 });
        const persona = await storage.getPersona();
        const assets = await storage.listAssets({ limit: 1000 });
        const sourceIds = new Set<string>();
        const unitSources: UnitSource[] = [];
        for (const unit of units) {
          const citations = await storage.getCitationsForUnit(unit.id);
          for (const c of citations) {
            unitSources.push(c);
            sourceIds.add(c.sourceId);
          }
        }
        const sources = await storage.sourcesByIds([...sourceIds]);
        const bundle: ExportBundle = {
          version: 1,
          exportedAt: nowIso(),
          graph,
          units,
          links,
          traces,
          sources,
          unitSources,
          scenarios,
          persona,
          assets,
        };
        await emitActivity(
          'export',
          `Exported ${units.length} units / ${links.length} links / ${scenarios.length} scenarios / ${assets.length} assets`,
          {
            units: units.length,
            links: links.length,
            traces: traces.length,
            sources: sources.length,
            scenarios: scenarios.length,
            assets: assets.length,
          },
        );
        return bundle;
      },

      health() {
        return { ok: true, version: '0.1.0', embeddingMode: embed.mode };
      },

      setLlm(next: LlmClient) {
        llm = next;
      },

      setEmbedder(next: Embedder) {
        embed = next;
      },
    };

    return service;
  };
  return make();
}
