import type {
  AiProvider,
  AiProviderInput,
  Asset,
  AssetId,
  AssetKind,
  AssetStatus,
  AssetVersion,
  ActivityEvent,
  IsoDate, Link, NewZone, SessionId, Source, StatsCounts, Storage, Trace, TraceId, Unit, UnitId,
  UnitSource, UnitSummary, UnitType, Version, VersionId, Persona, Scenario, ScenarioId,
  ScenarioStatus, Zone, ZoneMember,
} from '../src/domain.js';

function iso(d: Date = new Date()): IsoDate {
  return d.toISOString();
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** Minimal in-memory Storage for deterministic offline core tests. */
export class FakeStorage implements Storage {
  units = new Map<UnitId, Unit>();
  links = new Map<string, Link>();
  traces = new Map<TraceId, Trace>();
  sources = new Map<string, Source>();
  citations = new Map<string, UnitSource[]>();
  sessions = new Map<SessionId, { id: SessionId; label: string; agent?: string }>();
  versions = new Map<UnitId, Version[]>();
  scenarios = new Map<ScenarioId, Scenario>();
  persona: Persona | null = null;
  assets = new Map<AssetId, Asset>();
  assetVersions = new Map<AssetId, AssetVersion[]>();
  jobs: Array<{ id: string; kind: string; status: string }> = [];
  events: Array<{ kind: string; summary: string; meta?: Record<string, unknown> }> = [];
  zones = new Map<string, Zone>();
  zoneMembers = new Map<string, ZoneMember[]>();

  async dbHealth(): Promise<{ ok: boolean; status: string; journal: string; units: number }> {
    return { ok: true, status: 'ok', journal: 'truncate', units: this.units.size };
  }

  wrap(u: Unit): Unit {
    return { ...clone(u), embedding: u.embedding ? clone(u.embedding) : undefined };
  }

  async createUnit(unit: Unit): Promise<void> {
    this.units.set(unit.id, this.wrap(unit));
  }
  async getUnit(id: UnitId): Promise<Unit | null> {
    const u = this.units.get(id);
    return u ? this.wrap(u) : null;
  }
  async updateUnit(unit: Unit): Promise<void> {
    this.units.set(unit.id, this.wrap(unit));
  }
  async deleteUnit(id: UnitId): Promise<void> {
    this.units.delete(id);
  }
  async listUnits(filter?: import('../src/store.js').UnitFilter): Promise<UnitSummary[]> {
    let arr = [...this.units.values()];
    if (filter?.type) arr = arr.filter((u) => u.type === filter.type);
    if (filter?.status) arr = arr.filter((u) => u.status === filter.status);
    if (filter?.tag) arr = arr.filter((u) => u.tags.includes(filter.tag!));
    arr = arr.slice(filter?.offset ?? 0, (filter?.offset ?? 0) + (filter?.limit ?? 50));
    return arr.map((u) => ({
      id: u.id, type: u.type, form: u.form, title: u.title, summary: u.summary,
      tags: u.tags, zoneId: u.zoneId, createdByUserId: u.createdByUserId,
      importance: u.importance, decay: u.decay, status: u.status, updatedAt: u.updatedAt,
    }));
  }
  async allUnitsWithEmbeddings(limit?: number): Promise<Unit[]> {
    const list = [...this.units.values()].filter((u) => u.status !== 'archived');
    return (limit && limit > 0 ? list.slice(0, limit) : list).map((u) => this.wrap(u));
  }
  async allUnits(): Promise<Unit[]> {
    return [...this.units.values()]
      .filter((u) => u.status !== 'archived')
      .map((u) => {
        const { embedding: _embedding, ...light } = this.wrap(u);
        void _embedding;
        return light as Unit;
      });
  }
  async updateUnits(units: Unit[]): Promise<void> {
    for (const unit of units) {
      const existing = this.units.get(unit.id);
      if (!existing) continue;
      this.units.set(
        unit.id,
        this.wrap({
          ...existing,
          form: unit.form,
          status: unit.status,
          importance: unit.importance,
          decay: unit.decay,
        }),
      );
    }
  }
  async updateUnitEmbedding(
    id: UnitId,
    embedding: Unit['embedding'],
  ): Promise<void> {
    const existing = this.units.get(id);
    if (!existing) return;
    this.units.set(id, this.wrap({ ...existing, embedding }));
  }
  async sourceCountsByUnit(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const [unitId, list] of this.citations) {
      out.set(unitId, new Set(list.map((c) => c.sourceId)).size);
    }
    return out;
  }
  async createLink(link: Link): Promise<void> {
    this.links.set(link.id, clone(link));
  }
  async createLinks(links: Link[]): Promise<void> {
    for (const link of links) this.links.set(link.id, clone(link));
  }
  async upsertLink(link: Link): Promise<void> {
    this.links.set(link.id, clone(link));
  }
  async getLinksForUnit(unitId: UnitId): Promise<Link[]> {
    return [...this.links.values()].filter((l) => l.sourceUnitId === unitId || l.targetUnitId === unitId);
  }
  async allLinks(): Promise<Link[]> {
    return [...this.links.values()].map((l) => clone(l));
  }
  async deleteLink(id: string): Promise<void> {
    this.links.delete(id);
  }
  async deleteLinks(ids: string[]): Promise<void> {
    for (const id of ids) this.links.delete(id);
  }
  async createTrace(trace: Trace): Promise<void> {
    this.traces.set(trace.id, clone(trace));
  }
  async getTrace(id: TraceId): Promise<Trace | null> {
    return this.traces.get(id) ? clone(this.traces.get(id)!) : null;
  }
  async listTraces(filter?: { sessionId?: SessionId; limit?: number }): Promise<Trace[]> {
    let arr = [...this.traces.values()];
    if (filter?.sessionId) arr = arr.filter((t) => t.sessionId === filter.sessionId);
    if (filter?.limit) arr = arr.slice(0, filter.limit);
    return arr.map((t) => clone(t));
  }
  async upsertSession(session: { id: SessionId; label: string; agent?: string }): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async upsertSource(source: Source): Promise<Source> {
    this.sources.set(source.id, clone(source));
    return source;
  }
  async getSource(id: string): Promise<Source | null> {
    return this.sources.get(id) ? clone(this.sources.get(id)!) : null;
  }
  async sourcesByIds(ids: string[]): Promise<Source[]> {
    return ids.map((id) => this.sources.get(id)).filter((s): s is Source => Boolean(s)).map((s) => clone(s));
  }
  async addCitation(citation: UnitSource): Promise<void> {
    const list = this.citations.get(citation.unitId) ?? [];
    list.push(clone(citation));
    this.citations.set(citation.unitId, list);
  }
  async getCitationsForUnit(unitId: UnitId): Promise<UnitSource[]> {
    return (this.citations.get(unitId) ?? []).map((c) => clone(c));
  }
  async distinctSourceIdsForUnit(unitId: UnitId): Promise<string[]> {
    return [...new Set((this.citations.get(unitId) ?? []).map((c) => c.sourceId))];
  }
  async createVersion(version: Version): Promise<VersionId> {
    const list = this.versions.get(version.unitId) ?? [];
    list.push(clone(version));
    this.versions.set(version.unitId, list);
    return version.id;
  }
  async listVersions(unitId: UnitId): Promise<Version[]> {
    return (this.versions.get(unitId) ?? []).map((v) => clone(v));
  }
  async listScenarios(
    filter?: { tag?: string; status?: ScenarioStatus; limit?: number; sort?: 'updated' | 'heat' },
  ): Promise<Scenario[]> {
    let arr = [...this.scenarios.values()];
    if (filter?.status) arr = arr.filter((s) => s.status === filter.status);
    if (filter?.tag) arr = arr.filter((s) => s.tags.includes(filter.tag!));
    if (filter?.sort === 'heat') arr = [...arr].sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0));
    if (filter?.limit !== undefined) arr = arr.slice(0, filter.limit);
    return arr.map((s) => clone(s));
  }
  async getScenario(id: ScenarioId): Promise<Scenario | null> {
    const s = this.scenarios.get(id);
    return s ? clone(s) : null;
  }
  async createScenario(scenario: Scenario): Promise<void> {
    this.scenarios.set(scenario.id, clone({ ...scenario, heat: scenario.heat ?? 0 }));
  }
  async updateScenario(scenario: Scenario): Promise<void> {
    this.scenarios.set(scenario.id, clone(scenario));
  }
  async bumpScenarioHeat(id: ScenarioId): Promise<void> {
    const s = this.scenarios.get(id);
    if (!s) return;
    this.scenarios.set(id, {
      ...clone(s),
      heat: (s.heat ?? 0) + 1,
      lastHitAt: new Date().toISOString(),
    });
  }
  async deleteScenario(id: ScenarioId): Promise<void> {
    this.scenarios.delete(id);
  }
  async getPersona(): Promise<Persona | null> {
    return this.persona ? clone(this.persona) : null;
  }
  async upsertPersona(persona: Persona): Promise<void> {
    this.persona = clone(persona);
  }
  async listAssets(filter?: { kind?: AssetKind; status?: AssetStatus; limit?: number }): Promise<Asset[]> {
    let arr = [...this.assets.values()];
    if (filter?.kind) arr = arr.filter((a) => a.kind === filter.kind);
    if (filter?.status) arr = arr.filter((a) => a.status === filter.status);
    if (filter?.limit !== undefined) arr = arr.slice(0, filter.limit);
    return arr.map((a) => clone(a));
  }
  async listEquipped(agent: string): Promise<Asset[]> {
    return [...this.assets.values()]
      .filter(
        (a) =>
          a.status === 'published' &&
          (a.visibility === 'public' || a.visibility === 'workspace' || (a.boundAgents ?? []).includes(agent)),
      )
      .map((a) => clone(a));
  }
  async getAsset(id: AssetId): Promise<Asset | null> {
    const a = this.assets.get(id);
    return a ? clone(a) : null;
  }
  async listAssetVersions(id: AssetId): Promise<AssetVersion[]> {
    return [...(this.assetVersions.get(id) ?? [])].map((v) => clone(v));
  }
  async snapshotAssetVersion(asset: Asset, reason: string): Promise<void> {
    const { id, ...rest } = asset;
    const list = this.assetVersions.get(id) ?? [];
    list.push({
      id: `av_${list.length + 1}`,
      assetId: id,
      version: asset.version,
      snapshot: clone(rest),
      reason,
      createdAt: new Date().toISOString(),
    });
    this.assetVersions.set(id, list);
  }
  async createAsset(asset: Asset): Promise<void> {
    this.assets.set(asset.id, clone(asset));
  }
  async updateAsset(asset: Asset): Promise<void> {
    this.assets.set(asset.id, clone(asset));
  }
  async deleteAsset(id: AssetId): Promise<void> {
    this.assets.delete(id);
  }
  async counts(): Promise<StatsCounts> {
    const arr = [...this.units.values()];
    return {
      units: arr.length,
      unitsActive: arr.filter((u) => u.status !== 'archived').length,
      crystals: arr.filter((u) => u.form === 'crystal').length,
      traces: this.traces.size,
      links: this.links.size,
      sources: this.sources.size,
      sessions: this.sessions.size,
      pendingReview: arr.filter((u) => u.status === 'pending').length,
    };
  }
  async byTypeCounts(): Promise<Partial<Record<UnitType, number>>> {
    const out: Partial<Record<UnitType, number>> = {};
    for (const u of this.units.values()) out[u.type] = (out[u.type] ?? 0) + 1;
    return out;
  }
  async perDay(_limit = 30): Promise<Array<{ day: string; units: number; traces: number }>> {
    return [];
  }
  async recordJob(
    job: { kind: string; status: string; meta?: Record<string, unknown>; error?: string },
  ): Promise<string> {
    const id = `job-${this.jobs.length + 1}`;
    this.jobs.push({ id, kind: job.kind, status: job.status });
    return id;
  }
  async markJob(id: string, status: string, _details?: { error?: string; finishedAt?: IsoDate }): Promise<void> {
    const j = this.jobs.find((x) => x.id === id);
    if (j) j.status = status;
  }
  async recordEvent(event: { kind: string; summary: string; actor?: string; meta?: Record<string, unknown> }): Promise<string> {
    const id = `evt-${this.events.length + 1}`;
    this.events.push({ kind: event.kind, summary: event.summary, meta: event.meta });
    return id;
  }
  async listEvents(): Promise<ActivityEvent[]> {
    return this.events.map((e, i) => ({
      id: `evt-${i + 1}`,
      kind: e.kind,
      summary: e.summary,
      meta: e.meta,
      createdAt: iso(),
    }));
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async close(): Promise<void> {}

  // --- Zones ---
  async listZones(): Promise<Zone[]> {
    return [...this.zones.values()].map((z) => clone(z));
  }
  async getZone(id: string): Promise<Zone | null> {
    const z = this.zones.get(id);
    return z ? clone(z) : null;
  }
  async createZone(zone: NewZone): Promise<Zone> {
    const now = iso();
    const full: Zone = {
      id: `z_${this.zones.size + 1}`,
      workspaceId: zone.workspaceId,
      slug: zone.slug,
      name: zone.name,
      kind: zone.kind,
      ownerUserId: zone.ownerUserId,
      visibility: zone.visibility ?? 'private',
      description: zone.description,
      embeddingCentroid: zone.embeddingCentroid,
      auto: zone.auto ?? false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.zones.set(full.id, full);
    return clone(full);
  }
  async updateZone(zone: Zone): Promise<void> {
    this.zones.set(zone.id, clone(zone));
  }
  async deleteZone(id: string): Promise<void> {
    this.zones.delete(id);
  }
  async listZoneMembers(zoneId: string): Promise<ZoneMember[]> {
    return (this.zoneMembers.get(zoneId) ?? []).map((m) => clone(m));
  }
  async addZoneMember(zoneId: string, userId: string, role: ZoneMember['role']): Promise<void> {
    const list = this.zoneMembers.get(zoneId) ?? [];
    if (!list.some((m) => m.userId === userId)) {
      list.push({ zoneId, userId, role, createdAt: iso() });
      this.zoneMembers.set(zoneId, list);
    }
  }
  async removeZoneMember(zoneId: string, userId: string): Promise<void> {
    this.zoneMembers.set(
      zoneId,
      (this.zoneMembers.get(zoneId) ?? []).filter((m) => m.userId !== userId),
    );
  }
  async moveUnitZone(unitId: UnitId, zoneId: string): Promise<void> {
    const u = this.units.get(unitId);
    if (u) {
      this.units.set(unitId, this.wrap({ ...u, zoneId }));
    }
  }

  // --- AI providers ---
  providers = new Map<string, AiProvider>();
  async listProviders(): Promise<AiProvider[]> {
    return [...this.providers.values()].map((p) => clone(p));
  }
  async getActiveProvider(): Promise<AiProvider | null> {
    const p = [...this.providers.values()].find((x) => x.isActive);
    return p ? clone(p) : null;
  }
  async upsertProvider(provider: AiProviderInput & { id: string }): Promise<AiProvider> {
    const existing = this.providers.get(provider.id);
    const now = iso();
    const full: AiProvider = {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: provider.apiKey ?? existing?.apiKey,
      isActive: provider.isActive ?? existing?.isActive ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.providers.set(full.id, full);
    return clone(full);
  }
  async deleteProvider(id: string): Promise<void> {
    this.providers.delete(id);
  }
  async setActiveProvider(id: string | null): Promise<void> {
    for (const p of this.providers.values()) p.isActive = false;
    if (id) {
      const p = this.providers.get(id);
      if (p) p.isActive = true;
    }
  }
}

export function makeUnit(over: Partial<Unit>): Unit {
  return {
    id: 'u1', type: 'fact', form: 'unit', title: 'Sample', summary: 'summary', body: 'body',
    tags: [], labels: {}, status: 'reviewed', quality: 0.8, confidence: 0.7,
    createdAt: iso(), updatedAt: iso(), sourceCount: 0, importance: 0.5, decay: 1, version: 1,
    ...over,
  };
}

/** Seed the production default zones (inbox + shared) for a workspace. */
export async function seedDefaultZones(
  storage: Storage,
  workspaceId = 'ws_personal',
): Promise<{ inbox: Zone; shared: Zone }> {
  const inbox = await storage.createZone({
    workspaceId,
    slug: 'inbox',
    name: 'Inbox',
    kind: 'inbox',
    visibility: 'workspace',
    description: 'Uncategorized memory awaiting assignment',
  });
  const shared = await storage.createZone({
    workspaceId,
    slug: 'shared',
    name: 'Shared',
    kind: 'shared',
    visibility: 'workspace',
    description: 'Shared across all workspace members',
  });
  return { inbox, shared };
}

export { iso };
