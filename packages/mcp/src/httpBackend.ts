/**
 * HTTP-backed AmemService for stdio MCP.
 * When AMEM_BASE_URL points at a running server, stdio must NOT open the same SQLite file
 * (Docker bind-mount dual-writer corruption). This backend talks REST only.
 */
import type {
  ActivityEvent,
  ActivityFilter,
  ActivitySummary,
  AmemService,
  Asset,
  AssetCallResult,
  AssetExtractResult,
  AssetId,
  AssetKind,
  AssetRouteResult,
  AssetStatus,
  AssetVersion,
  CurateReport,
  CompactInput,
  CompactResult,
  EmbeddingMode,
  ExportBundle,
  ImportCodebaseInput,
  ImportDirInput,
  ImportResult,
  ImportSessionsInput,
  ImportSourcesResult,
  IngestInput,
  IngestResult,
  IsoDate,
  LayerRefreshResult,
  LayeredRecallResult,
  Link,
  LinkRelation,
  NewAsset,
  NewUnit,
  Persona,
  PrecipitateResult,
  RecallInput,
  RecallResult,
  RouteAssetsInput,
  Scenario,
  ScenarioId,
  ScenarioStatus,
  SearchResult,
  SeedInput,
  SeedResult,
  SessionId,
  SkillExtractResult,
  Stats,
  Trace,
  TraceId,
  Unit,
  UnitId,
  UnitStatus,
  UnitSummary,
  UnitType,
  WorkingMemory,
  Graph,
} from '@amem/core';

export interface HttpBackendOpts {
  baseUrl: string;
  token?: string;
  workspace?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function createHttpAmemService(opts: HttpBackendOpts): AmemService {
  const base = opts.baseUrl.replace(/\/$/, '');
  const api = `${base}/api/v1`;

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.workspace) headers['x-amem-workspace'] = opts.workspace;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(`${api}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } })?.error;
      throw new HttpError(res.status, err?.code || 'HTTP', err?.message || text.slice(0, 300));
    }
    return data as T;
  }

  const qs = (params: Record<string, string | number | boolean | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === '') continue;
      s.set(k, String(v));
    }
    const q = s.toString();
    return q ? `?${q}` : '';
  };

  return {
    async ingest(input: IngestInput): Promise<IngestResult> {
      return req('POST', '/ingest', input);
    },
    async compact(input: CompactInput): Promise<CompactResult> {
      return req('POST', '/compact', input);
    },
    async recall(input: RecallInput): Promise<RecallResult> {
      return req('POST', '/recall', input);
    },
    async recallLayered(input: RecallInput): Promise<LayeredRecallResult> {
      return req('POST', '/recall/layered', input);
    },
    async search(query: string, o?: { limit?: number; includeBody?: boolean }): Promise<SearchResult> {
      return req('GET', `/search${qs({ q: query, limit: o?.limit, includeBody: o?.includeBody })}`);
    },
    async saveUnit(unit: NewUnit): Promise<Unit> {
      return req('POST', '/units', { unit });
    },
    async getUnit(id: UnitId): Promise<Unit | null> {
      try {
        return await req('GET', `/units/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
    async updateUnit(id: UnitId, patch: Partial<NewUnit>, reason?: string): Promise<Unit> {
      return req('PATCH', `/units/${encodeURIComponent(id)}`, { patch, reason });
    },
    async deleteUnit(id: UnitId, _reason?: string): Promise<void> {
      await req('DELETE', `/units/${encodeURIComponent(id)}`);
    },
    async reviewUnit(id: UnitId, action: 'accept' | 'discard'): Promise<Unit | null> {
      return req('POST', `/units/${encodeURIComponent(id)}/review`, { action });
    },
    async listUnits(filter?: {
      type?: UnitType;
      status?: UnitStatus;
      tag?: string;
      category?: string;
      limit?: number;
      offset?: number;
    }): Promise<UnitSummary[]> {
      return req(
        'GET',
        `/units${qs({
          type: filter?.type,
          status: filter?.status,
          tag: filter?.tag,
          category: filter?.category,
          limit: filter?.limit,
          offset: filter?.offset,
        })}`,
      );
    },
    async classifyUnits(opts?: {
      ids?: string[];
      mode?: 'rules' | 'llm' | 'auto';
      reclassify?: boolean;
    }) {
      return req('POST', '/units/classify', opts ?? {});
    },
    async batchUnits(opts: { ids: string[]; action: 'archive' | 'restore' | 'delete' | 'accept' }) {
      return req('POST', '/units/batch', opts);
    },
    async getGraph(includeClusters?: boolean): Promise<Graph> {
      return req('GET', `/graph${qs({ clusters: includeClusters ? '1' : undefined })}`);
    },
    async linkUnits(input: {
      sourceUnitId: UnitId;
      targetUnitId: UnitId;
      relation: LinkRelation;
      reason?: string;
      auto?: boolean;
    }): Promise<Link> {
      return req('POST', '/links', input);
    },
    async getLinksForUnit(unitId: UnitId): Promise<Link[]> {
      return req('GET', `/links/${encodeURIComponent(unitId)}`);
    },
    async pruneAutoLinks(opts?: { maxPerUnit?: number; dryRun?: boolean }) {
      return req('POST', '/links/prune', opts ?? {});
    },
    async workingMemory(date?: IsoDate, budget?: number): Promise<WorkingMemory> {
      return req('GET', `/working-memory${qs({ date, budget })}`);
    },
    async listScenarios(filter?: { tag?: string; status?: ScenarioStatus; limit?: number }): Promise<Scenario[]> {
      return req(
        'GET',
        `/scenarios${qs({ tag: filter?.tag, status: filter?.status, limit: filter?.limit })}`,
      );
    },
    async getScenario(id: ScenarioId): Promise<Scenario | null> {
      try {
        return await req('GET', `/scenarios/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
    async refreshLayers(opts?: { tags?: string[]; forcePersona?: boolean; maxScenarios?: number; mode?: 'fast' | 'auto' | 'full' }): Promise<LayerRefreshResult> {
      return req('POST', '/layers/refresh', opts ?? {});
    },
    async getPersona(): Promise<Persona | null> {
      return req('GET', '/persona');
    },
    async listAssets(filter?: { kind?: AssetKind; status?: AssetStatus; limit?: number }): Promise<Asset[]> {
      return req(
        'GET',
        `/assets${qs({ kind: filter?.kind, status: filter?.status, limit: filter?.limit })}`,
      );
    },
    async listEquipped(agent: string): Promise<Asset[]> {
      return req('GET', `/assets/equipped?agent=${encodeURIComponent(agent)}`);
    },
    async callAsset(input: { id: string; agent?: string; query?: string; budget?: number }): Promise<AssetCallResult> {
      return req('POST', `/assets/${encodeURIComponent(input.id)}/call`, input);
    },
    async routeAssets(input: RouteAssetsInput): Promise<AssetRouteResult> {
      return req('POST', '/assets/route', input);
    },
    async getAsset(id: AssetId): Promise<Asset | null> {
      try {
        return await req('GET', `/assets/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
    async listAssetVersions(id: AssetId): Promise<AssetVersion[]> {
      return req('GET', `/assets/${encodeURIComponent(id)}/versions`);
    },
    async saveAsset(asset: NewAsset): Promise<Asset> {
      return req('POST', '/assets', { asset });
    },
    async updateAsset(id: AssetId, patch: Partial<NewAsset>, reason?: string): Promise<Asset> {
      return req('PATCH', `/assets/${encodeURIComponent(id)}`, { patch, reason });
    },
    async deleteAsset(id: AssetId): Promise<void> {
      await req('DELETE', `/assets/${encodeURIComponent(id)}`);
    },
    async extractSkills(opts?: { limit?: number; includePending?: boolean }): Promise<SkillExtractResult> {
      return req('POST', '/skills/extract', opts ?? {});
    },
    async extractCodegraph(opts?: { limit?: number }): Promise<AssetExtractResult> {
      return req('POST', '/assets/extract/codegraph', opts ?? {});
    },
    async extractWiki(opts?: { limit?: number }): Promise<AssetExtractResult> {
      return req('POST', '/assets/extract/wiki', opts ?? {});
    },
    async autoPrecipitate(opts?: { mode?: 'fast' | 'auto' | 'full' }): Promise<PrecipitateResult> {
      return req('POST', '/layers/precipitate', opts ?? {});
    },
    async importDirectory(input: ImportDirInput): Promise<ImportSourcesResult> {
      return req('POST', '/import/directory', input);
    },
    async importCodebase(input: ImportCodebaseInput): Promise<ImportSourcesResult> {
      return req('POST', '/import/codebase', input);
    },
    async importSessions(input: ImportSessionsInput): Promise<ImportSourcesResult> {
      return req('POST', '/import/sessions', input);
    },
    async seed(input: SeedInput): Promise<SeedResult> {
      return req('POST', '/seed', input);
    },
    async forget(unitId: UnitId, reason: string): Promise<void> {
      // No dedicated forget route yet — map to delete.
      await req('DELETE', `/units/${encodeURIComponent(unitId)}${qs({ reason })}`);
    },
    async curate(preset?: 'fast' | 'full'): Promise<CurateReport> {
      return req('POST', '/curate', { preset: preset || 'fast' });
    },
    async stats(): Promise<Stats> {
      return req('GET', '/stats');
    },
    async activity(filter?: ActivityFilter): Promise<ActivityEvent[]> {
      return req('GET', `/activity${qs({ kind: filter?.kind, limit: filter?.limit })}`);
    },
    async activitySummary(filter?: { hours?: number; limit?: number }): Promise<ActivitySummary> {
      return req('GET', `/activity/summary${qs({ hours: filter?.hours, limit: filter?.limit })}`);
    },
    async getTraces(filter?: { sessionId?: SessionId; limit?: number }): Promise<Trace[]> {
      return req('GET', `/traces${qs({ sessionId: filter?.sessionId, limit: filter?.limit })}`);
    },
    async getTrace(id: TraceId): Promise<Trace | null> {
      try {
        return await req('GET', `/traces/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
    async import(payload: ExportBundle): Promise<ImportResult> {
      return req('POST', '/import', payload);
    },
    async export(): Promise<ExportBundle> {
      return req('GET', '/export');
    },
    health(): { ok: boolean; version: string; embeddingMode: EmbeddingMode } {
      // health is sync on interface; expose last-known optimistic shape.
      // Callers that need live health use the async tool path which awaits callTool.
      return { ok: true, version: '0.1.0-http', embeddingMode: 'offline' };
    },
    // The LLM lives server-side (Settings → AI Providers). The stdio proxy has
    // no direct model to swap; the server already hot-swaps on activate/update.
    setLlm(): void {},
    setEmbedder(): void {},
  };
}

/** Live health via HTTP (async). */
export async function httpHealth(opts: HttpBackendOpts): Promise<{
  ok: boolean;
  version: string;
  embeddingMode: EmbeddingMode;
}> {
  const base = opts.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api/v1/health`, { headers });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return (await res.json()) as { ok: boolean; version: string; embeddingMode: EmbeddingMode };
}

export function shouldUseHttpBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  const base = (env.AMEM_BASE_URL || '').trim();
  if (!base) return false;
  // Explicit opt-out for rare offline stdio-on-file cases when server is stopped.
  if (env.AMEM_HTTP_PROXY === '0' || env.AMEM_HTTP_PROXY === 'false') return false;
  // Default ON whenever base URL is set — prevents Docker+stdio dual-writer.
  return true;
}
