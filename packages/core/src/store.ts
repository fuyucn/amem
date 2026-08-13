/**
 * Storage contract implemented by `@amem/db`.
 *
 * `core` engines depend only on this interface; `@amem/db` provides a
 * SQLite-backed implementation. Keeps layering clean and testable.
 */
import type {
  ActivityEvent,
  ActivityFilter,
  AiProvider,
  AiProviderInput,
  Asset,
  AssetId,
  AssetKind,
  AssetStatus,
  AssetVersion,
  IsoDate,
  Link,
  Persona,
  Scenario,
  ScenarioId,
  ScenarioStatus,
  SessionId,
  Source,
  StatsCounts,
  Trace,
  TraceId,
  Unit,
  UnitId,
  UnitSource,
  UnitSummary,
  UnitType,
  Version,
  VersionId,
} from './domain.js';

export interface UnitFilter {
  type?: UnitType;
  status?: Unit['status'];
  tag?: string;
  limit?: number;
  offset?: number;
  includeBody?: boolean;
}

export interface Storage {
  // --- Units ---
  createUnit(unit: Unit): Promise<void>;
  getUnit(id: UnitId): Promise<Unit | null>;
  updateUnit(unit: Unit): Promise<void>;
  deleteUnit(id: UnitId): Promise<void>;
  listUnits(filter?: UnitFilter): Promise<UnitSummary[]>;
  /** All active units with embeddings (used by semantic search / recall).
   *  `limit` caps the row count (link generation only needs the freshest N). */
  allUnitsWithEmbeddings(limit?: number): Promise<Unit[]>;
  /** All active units without embeddings (list/graph/stats paths). */
  allUnits(): Promise<Unit[]>;
  /** Bulk update in one transaction (used by consolidation). */
  updateUnits(units: Unit[]): Promise<void>;

  // --- Links (edges) ---
  createLink(link: Link): Promise<void>;
  /** Bulk link insert in one transaction (used by link generation). */
  createLinks(links: Link[]): Promise<void>;
  upsertLink(link: Link): Promise<void>;
  getLinksForUnit(unitId: UnitId): Promise<Link[]>;
  allLinks(): Promise<Link[]>;
  deleteLink(id: string): Promise<void>;
  /** Bulk-delete links by id (used by link pruning). */
  deleteLinks(ids: string[]): Promise<void>;

  // --- Traces / sessions ---
  createTrace(trace: Trace): Promise<void>;
  getTrace(id: TraceId): Promise<Trace | null>;
  listTraces(filter?: { sessionId?: SessionId; limit?: number }): Promise<Trace[]>;
  upsertSession(session: { id: SessionId; label: string; agent?: string }): Promise<void>;

  // --- Sources / citations ---
  upsertSource(source: Source): Promise<Source>;
  getSource(id: string): Promise<Source | null>;
  sourcesByIds(ids: string[]): Promise<Source[]>;
  addCitation(citation: UnitSource): Promise<void>;
  getCitationsForUnit(unitId: UnitId): Promise<UnitSource[]>;
  distinctSourceIdsForUnit(unitId: UnitId): Promise<string[]>;
  /** Distinct source counts for every unit in one query (avoids N+1). */
  sourceCountsByUnit(): Promise<Map<string, number>>;

  // --- Versions (bi-temporal history) ---
  createVersion(version: Version): Promise<VersionId>;
  listVersions(unitId: UnitId): Promise<Version[]>;

  // --- L2 scenarios ---
  listScenarios(filter?: {
    tag?: string;
    status?: ScenarioStatus;
    limit?: number;
    /** sort order: 'updated' (default) or 'heat' (hot scenes first). */
    sort?: 'updated' | 'heat';
  }): Promise<Scenario[]>;
  getScenario(id: ScenarioId): Promise<Scenario | null>;
  createScenario(scenario: Scenario): Promise<void>;
  updateScenario(scenario: Scenario): Promise<void>;
  /** bump heat +1 and stamp last_hit_at (scene recall hit). */
  bumpScenarioHeat(id: ScenarioId): Promise<void>;
  deleteScenario(id: ScenarioId): Promise<void>;

  // --- L3 persona (one per workspace) ---
  getPersona(): Promise<Persona | null>;
  upsertPersona(persona: Persona): Promise<void>;

  // --- Assets ---
  listAssets(filter?: { kind?: AssetKind; status?: AssetStatus; limit?: number }): Promise<Asset[]>;
  listEquipped(agent: string): Promise<Asset[]>;
  getAsset(id: AssetId): Promise<Asset | null>;
  /** Version chain for an asset, newest first. */
  listAssetVersions(id: AssetId): Promise<AssetVersion[]>;
  /** Append an immutable snapshot of the given asset (used before content-changing updates). */
  snapshotAssetVersion(asset: Asset, reason: string): Promise<void>;
  createAsset(asset: Asset): Promise<void>;
  updateAsset(asset: Asset): Promise<void>;
  deleteAsset(id: AssetId): Promise<void>;

  // --- Stats ---
  counts(): Promise<StatsCounts>;
  byTypeCounts(): Promise<Partial<Record<UnitType, number>>>;
  perDay(limit?: number): Promise<Array<{ day: string; units: number; traces: number }>>;

  // --- Health ---
  /**
   * Probe storage health on the server's own connection. Implementations MUST
   * not open a second connection: on some filesystems (e.g. virtiofs bind
   * mounts) a second connection's journal pragma can fail with SQLITE_IOERR
   * while the primary writer is live.
   */
  dbHealth(): Promise<{ ok: boolean; status: string; journal: string; units: number }>;

  // --- Audit / jobs ---
  recordJob(job: { kind: string; status: string; meta?: Record<string, unknown>; error?: string }): Promise<string>;
  markJob(id: string, status: string, details?: { error?: string; finishedAt?: IsoDate }): Promise<void>;

  // --- Activity feed (Codex/UI visibility) ---
  recordEvent(event: {
    kind: string;
    summary: string;
    actor?: string;
    meta?: Record<string, unknown>;
  }): Promise<string>;
  listEvents(filter?: ActivityFilter): Promise<ActivityEvent[]>;

  // --- AI providers (instance-global, not workspace-scoped) ---
  listProviders(): Promise<AiProvider[]>;
  getActiveProvider(): Promise<AiProvider | null>;
  upsertProvider(provider: AiProviderInput & { id: string }): Promise<AiProvider>;
  deleteProvider(id: string): Promise<void>;
  /** Activate exactly one provider (or none when `id` is null). */
  setActiveProvider(id: string | null): Promise<void>;

  // --- Lifetime ---
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
