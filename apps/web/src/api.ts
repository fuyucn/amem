import type {
  ActivityEvent,
  ActivitySummary,
  AiProvider,
  AiStatus,
  Asset,
  AssetCallResult,
  AssetKind,
  AssetStatus,
  Graph, IngestResult, Link, RecallResult, SearchResult, Stats, Trace,
  Unit, UnitSummary, Version, WorkingMemory,
  Scenario, ScenarioStatus, Persona,
  LayeredRecallResult, LayerRefreshResult, SkillExtractResult, AssetExtractResult,
  PrecipitateResult, ImportSourcesResult,
} from './types';
import { authHeaders, getToken, setToken, getWorkspaceSlug, setWorkspaceSlug } from './auth';

const BASE = '/api/v1';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch { /* keep statusText */ }
    throw new Error(`${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const q = s.toString();
  return q ? `?${q}` : '';
};

export type Me = {
  realm: string;
  authEnabled: boolean;
  user: { id: string; email: string; name?: string | null } | null;
  workspace: { id: string; slug: string; name: string };
  scopes: string[];
  workspaces: Array<{ id: string; slug: string; name: string; kind?: string }>;
};

export const api = {
  health: () => request<{ ok: boolean; version: string }>('/health'),
  me: () => request<Me>('/me'),
  login: async (email: string, password: string) => {
    const out = await request<{ token: string; workspaces: Me['workspaces']; user: Me['user'] }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password, tokenName: 'web' }) },
    );
    setToken(out.token);
    if (out.workspaces?.[0]?.slug) setWorkspaceSlug(out.workspaces[0].slug);
    return out;
  },
  bootstrap: async (email: string, password: string, name?: string) => {
    const out = await request<{ token: string; workspace: { slug: string }; user: Me['user'] }>(
      '/auth/bootstrap',
      { method: 'POST', body: JSON.stringify({ email, password, name }) },
    );
    setToken(out.token);
    if (out.workspace?.slug) setWorkspaceSlug(out.workspace.slug);
    return out;
  },
  logout: () => {
    setToken('');
  },
  usePat: async (token: string) => {
    setToken(token);
    return request<Me>('/me');
  },
  workspaces: () => request<Array<{ id: string; slug: string; name: string; kind: string }>>('/workspaces'),
  createWorkspace: (body: { slug: string; name: string; kind?: 'personal' | 'company' }) =>
    request<{ id: string; slug: string; name: string; kind: string }>('/workspaces', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  tokens: () =>
    request<
      Array<{
        id: string;
        name: string;
        prefix: string;
        scopes: string[];
        workspaceIds: string[];
        createdAt: string;
        lastUsedAt?: string;
        expiresAt?: string;
      }>
    >('/auth/tokens'),
  createToken: (body: { name?: string; scopes?: string[]; workspaceIds?: string[]; ttlDays?: number }) =>
    request<{ id: string; token: string; name: string; prefix: string; scopes: string[]; workspaceIds: string[] }>(
      '/auth/tokens',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  revokeToken: (id: string) => request<{ ok: boolean }>(`/auth/tokens/${id}`, { method: 'DELETE' }),
  sessions: () =>
    request<
      Array<{
        id: string;
        kind: 'login' | 'oauth';
        type?: 'access' | 'refresh';
        clientId?: string | null;
        scopes?: string[];
        workspaceIds?: string[];
        familyId?: string;
        usedAt?: string | null;
        expiresAt?: string;
        createdAt?: string;
      }>
    >('/auth/sessions'),
  revokeSession: (id: string) =>
    request<{ ok: boolean }>(`/auth/sessions/${id}`, { method: 'DELETE' }),
  listMembers: (key: string) =>
    request<Array<{ userId: string; email: string; name: string | null; role: string; createdAt: string }>>(`/workspaces/${key}/members`),
  addMember: (key: string, body: { email: string; role?: string }) =>
    request<{ ok: boolean; userId: string; email: string; role: string }>(`/workspaces/${key}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeMember: (key: string, userId: string) =>
    request<{ ok: boolean }>(`/workspaces/${key}/members/${userId}`, { method: 'DELETE' }),
  setWorkspace: (slug: string) => setWorkspaceSlug(slug),
  getWorkspace: () => getWorkspaceSlug(),
  hasToken: () => Boolean(getToken()),

  ingest: (body: { title: string; content: string; contentType?: string; sourceUri?: string; sessionId?: string; autoReview?: boolean }) =>
    request<IngestResult>('/ingest', { method: 'POST', body: JSON.stringify(body) }),
  recall: (body: { query: string; tokenBudget?: number; topK?: number }) =>
    request<RecallResult>('/recall', { method: 'POST', body: JSON.stringify(body) }),
  recallLayered: (body: { query: string; tokenBudget?: number; topK?: number }) =>
    request<LayeredRecallResult>('/recall/layered', { method: 'POST', body: JSON.stringify(body) }),
  search: (
    query: string,
    f: { limit?: number; offset?: number; type?: string; category?: string; tag?: string; status?: string; fullText?: boolean } = {},
  ) => request<SearchResult>(`/search${qs({
    q: query,
    limit: f.limit,
    offset: f.offset,
    type: f.type,
    category: f.category,
    tag: f.tag,
    status: f.status,
    fullText: f.fullText ? 1 : undefined,
  })}`),
  stats: () => request<Stats>('/stats'),
  activity: (f: { kind?: string; limit?: number } = {}) =>
    request<ActivityEvent[]>(`/activity${qs(f)}`),
  activitySummary: (f: { hours?: number; limit?: number } = {}) =>
    request<ActivitySummary>(`/activity/summary${qs(f)}`),
  graph: (clusters = true, scenarios = true) =>
    request<Graph>(`/graph${qs({ clusters: clusters ? 1 : 0, scenarios: scenarios ? 1 : 0 })}`),
  units: (f: { type?: string; status?: string; tag?: string; category?: string; limit?: number } = {}) =>
    request<UnitSummary[]>(`/units${qs(f)}`),
  unit: (id: string) => request<Unit>(`/units/${id}`),
  versions: (id: string) => request<Version[]>(`/units/${id}/versions`),
  linksForUnit: (id: string) => request<Link[]>(`/links/${id}`),
  createUnit: (unit: Partial<Unit>) => request<Unit>('/units', { method: 'POST', body: JSON.stringify({ unit }) }),
  updateUnit: (id: string, patch: Partial<Unit>, reason?: string) =>
    request<Unit>(`/units/${id}`, { method: 'PATCH', body: JSON.stringify({ patch, reason }) }),
  deleteUnit: (id: string) => request<void>(`/units/${id}`, { method: 'DELETE' }),
  reviewUnit: (id: string, action: 'accept' | 'discard') =>
    request<Unit | null>(`/units/${id}/review`, { method: 'POST', body: JSON.stringify({ action }) }),
  classifyUnits: (body: { ids?: string[]; mode?: 'rules' | 'llm' | 'auto'; reclassify?: boolean } = {}) =>
    request<{ examined: number; classified: number; byCategory: Record<string, number>; persisted?: number }>(
      '/units/classify',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  batchUnits: (body: { ids: string[]; action: 'archive' | 'restore' | 'delete' | 'accept' }) =>
    request<{ affected: number; skipped: number }>('/units/batch', { method: 'POST', body: JSON.stringify(body) }),
  traces: () => request<Trace[]>('/traces'),
  trace: (id: string) => request<Trace>(`/traces/${id}`),
  workingMemory: () => request<WorkingMemory>('/working-memory'),
  curate: () => request<{ linksCreated: number; crystalsPromoted: number; archived: number }>('/curate', { method: 'POST', body: JSON.stringify({}) }),
  scenarios: (f: { tag?: string; status?: ScenarioStatus; limit?: number; sort?: 'updated' | 'heat' } = {}) =>
    request<Scenario[]>(`/scenarios${qs(f)}`),
  scenario: (id: string) => request<Scenario>(`/scenarios/${id}`),
  refreshLayers: (body: { tags?: string[]; forcePersona?: boolean; maxScenarios?: number; mode?: 'fast' | 'auto' | 'full' } = {}) =>
    request<LayerRefreshResult>('/layers/refresh', { method: 'POST', body: JSON.stringify(body) }),
  persona: () => request<Persona | null>('/persona'),
  assets: (f: { kind?: AssetKind; status?: AssetStatus; limit?: number } = {}) =>
    request<Asset[]>(`/assets${qs(f)}`),
  asset: (id: string) => request<Asset>(`/assets/${id}`),
  equippedAssets: (agent: string) => request<Asset[]>(`/assets/equipped?agent=${encodeURIComponent(agent)}`),
  callAsset: (id: string, body: { agent?: string; query?: string; budget?: number } = {}) =>
    request<AssetCallResult>(`/assets/${id}/call`, { method: 'POST', body: JSON.stringify(body) }),
  createAsset: (asset: Partial<Asset>) =>
    request<Asset>('/assets', { method: 'POST', body: JSON.stringify({ asset }) }),
  updateAsset: (id: string, patch: Partial<Asset>, reason?: string) =>
    request<Asset>(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify({ patch, reason }) }),
  deleteAsset: (id: string) => request<void>(`/assets/${id}`, { method: 'DELETE' }),
  extractSkills: (body: { limit?: number; includePending?: boolean } = {}) =>
    request<SkillExtractResult>('/skills/extract', { method: 'POST', body: JSON.stringify(body) }),
  extractCodegraph: (body: { limit?: number } = {}) =>
    request<AssetExtractResult>('/assets/extract/codegraph', { method: 'POST', body: JSON.stringify(body) }),
  extractWiki: (body: { limit?: number } = {}) =>
    request<AssetExtractResult>('/assets/extract/wiki', { method: 'POST', body: JSON.stringify(body) }),
  precipitate: (body: { mode?: 'fast' | 'auto' | 'full' } = {}) =>
    request<PrecipitateResult>('/layers/precipitate', { method: 'POST', body: JSON.stringify(body) }),
  importDirectory: (body: { path: string; extensions?: string[]; extract?: boolean }) =>
    request<ImportSourcesResult>('/import/directory', { method: 'POST', body: JSON.stringify(body) }),
  importCodebase: (body: { path: string; extensions?: string[]; maxFiles?: number }) =>
    request<ImportSourcesResult>('/import/codebase', { method: 'POST', body: JSON.stringify(body) }),
  importSessions: (body: { path: string; format?: string; sessionLabel?: string; extract?: boolean }) =>
    request<ImportSourcesResult>('/import/sessions', { method: 'POST', body: JSON.stringify(body) }),
  providers: () => request<{ providers: AiProvider[] }>('/providers').then((r) => r.providers),
  createProvider: (body: {
    name: string;
    baseUrl: string;
    model: string;
    embeddingModel?: string;
    embeddingBaseUrl?: string;
    embeddingApiKey?: string;
    apiKey?: string;
  }) =>
    request<AiProvider>('/providers', { method: 'POST', body: JSON.stringify(body) }),
  updateProvider: (
    id: string,
    body: Partial<{
      name: string;
      baseUrl: string;
      model: string;
      embeddingModel?: string;
      embeddingBaseUrl?: string;
      embeddingApiKey?: string;
      apiKey?: string;
    }>,
  ) =>
    request<AiProvider>(`/providers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean }>(`/providers/${id}`, { method: 'DELETE' }),
  activateProvider: (id: string) =>
    request<{ ok: boolean; active: AiProvider | null }>(`/providers/${id}/activate`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  testProvider: (id: string) =>
    request<{ ok: boolean; latencyMs: number; error?: string; model?: string }>(
      `/providers/${id}/test`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  aiStatus: () => request<AiStatus>('/ai/status'),
};
