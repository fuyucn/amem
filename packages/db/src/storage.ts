import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { migrate, configureSqliteConnection, ensureSqliteHealthy } from './schema.js';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type {
  ActivityEvent,
  ActivityFilter,
  AiProvider,
  AiProviderInput,
  Asset,
  AssetId,
  AssetVersion,
  Embedding,
  IsoDate,
  Job,
  Link,
  Persona,
  PipelineStage,
  Scenario,
  ScenarioId,
  Session,
  SessionId,
  Source,
  StatsCounts,
  Storage,
  Trace,
  Unit,
  UnitId,
  UnitSource,
  UnitSummary,
  TraceId,
  UnitType,
  Version,
  VersionId,
} from '@amem/core';
import { DEFAULT_WORKSPACE_ID, requireRequestContext } from '@amem/core';
import { decryptProviderKey, encryptProviderKey } from './providerCrypto.js';

function currentWorkspaceId(): string {
  try {
    return requireRequestContext().workspaceId || DEFAULT_WORKSPACE_ID;
  } catch {
    return DEFAULT_WORKSPACE_ID;
  }
}

// --- SQL statement strings -------------------------------------------------

const INSERT_UNIT = `
  INSERT INTO units (
    id, type, form, title, summary, body, status, quality, confidence,
    embedding, created_at, updated_at, valid_from, valid_to, source_count,
    importance, decay, version, labels, tags
  ) VALUES (
    @id, @type, @form, @title, @summary, @body, @status, @quality, @confidence,
    @embedding, @created_at, @updated_at, @valid_from, @valid_to, @source_count,
    @importance, @decay, @version, @labels, @tags
  )
`;

const UPDATE_UNIT = `
  UPDATE units SET
    type = @type, form = @form, title = @title, summary = @summary,
    body = @body, status = @status, quality = @quality, confidence = @confidence,
    embedding = @embedding, updated_at = @updated_at, valid_from = @valid_from,
    valid_to = @valid_to, source_count = @source_count, importance = @importance,
    decay = @decay, version = @version, labels = @labels, tags = @tags
  WHERE id = @id
`;

/** Narrow bulk update used by consolidation: only the fields a maintenance
 *  pass may change. Never touches `embedding`, so batch writes from light
 *  unit reads cannot wipe stored vectors. */
const UPDATE_UNIT_LIGHT = `
  UPDATE units SET
    form = @form, status = @status, importance = @importance, decay = @decay
  WHERE id = @id
`;

// --- Row shapes --------------------------------------------------------------

interface UnitRow {
  id: string;
  type: UnitType;
  form: Unit['form'];
  title: string;
  summary: string;
  body: string;
  status: Unit['status'];
  quality: number;
  confidence: number;
  embedding: string | Buffer | null;
  created_at: string;
  updated_at: string;
  valid_from: string | null;
  valid_to: string | null;
  source_count: number;
  importance: number;
  decay: number;
  version: number;
  labels: string;
  tags: string;
}

const LIGHT_UNIT_COLUMNS = `id, type, form, title, summary, body, status, quality, confidence,
  created_at, updated_at, valid_from, valid_to, source_count, importance, decay, version, labels, tags`;

/** Compact binary embedding: raw Float32 values. ~4x smaller and much faster to
 *  parse than the legacy JSON text format (no array allocation per number). */
function encodeEmbedding(e: Embedding): Buffer {
  const f32 = new Float32Array(e.values);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function decodeEmbedding(v: string | Buffer): Embedding {
  if (typeof v === 'string') {
    // Legacy rows written before the BLOB format (JSON text) still parse.
    return JSON.parse(v) as Embedding;
  }
  const f32 = new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
  return { dims: f32.length, values: Array.from(f32) };
}

interface LinkRow {
  id: string;
  source_unit_id: string;
  target_unit_id: string;
  relation: Link['relation'];
  reason: string;
  confidence: number;
  auto: number;
  created_at: string;
}

interface TraceRow {
  id: string;
  session_id: string | null;
  title: string;
  content: string;
  content_type: string;
  token_count: number;
  created_at: string;
}

interface SourceRow {
  id: string;
  uri: string | null;
  title: string;
  kind: Source['kind'];
  content_hash: string;
  content_length: number;
  created_at: string;
}

interface CitationRow {
  unit_id: string;
  source_id: string;
  span: string | null;
  asserted_at: string;
}

interface VersionRow {
  id: string;
  unit_id: string;
  version: number;
  snapshot: string;
  reason: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  label: string;
  agent: string | null;
  created_at: string;
  updated_at: string;
}

interface ProviderRow {
  id: string;
  name: string;
  kind: AiProvider['kind'];
  base_url: string;
  model: string;
  embedding_model: string;
  embedding_base_url: string;
  embedding_api_key: string;
  api_key: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface ScenarioRow {
  id: string;
  workspace_id: string;
  title: string;
  summary: string;
  content: string;
  tags: string;
  source_unit_ids: string;
  status: Scenario['status'];
  version: number;
  heat: number;
  last_hit_at: string | null;
  created_at: string;
  updated_at: string;
  last_consolidated_at: string | null;
}

interface PersonaRow {
  id: string;
  workspace_id: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AssetRow {
  id: string;
  workspace_id: string;
  kind: Asset['kind'];
  name: string;
  description: string;
  content: string;
  body: string;
  trigger: string;
  tags: string;
  source_unit_ids: string;
  status: Asset['status'];
  visibility: Asset['visibility'];
  bound_agents: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AssetVersionRow {
  id: string;
  asset_id: string;
  workspace_id: string;
  version: number;
  snapshot: string;
  reason: string;
  created_at: string;
}

// --- Mapping helpers ----------------------------------------------------------

function unitToRow(unit: Unit): UnitRow {
  return {
    id: unit.id,
    type: unit.type,
    form: unit.form,
    title: unit.title,
    summary: unit.summary,
    body: unit.body,
    status: unit.status,
    quality: unit.quality,
    confidence: unit.confidence,
    embedding: unit.embedding ? encodeEmbedding(unit.embedding) : null,
    created_at: unit.createdAt,
    updated_at: unit.updatedAt,
    valid_from: unit.validFrom ?? null,
    valid_to: unit.validTo ?? null,
    source_count: unit.sourceCount,
    importance: unit.importance,
    decay: unit.decay,
    version: unit.version,
    labels: JSON.stringify(unit.labels),
    tags: JSON.stringify(unit.tags),
  };
}

function rowToUnit(row: UnitRow): Unit {
  return {
    id: row.id,
    type: row.type,
    form: row.form,
    title: row.title,
    summary: row.summary,
    body: row.body,
    status: row.status,
    quality: row.quality,
    confidence: row.confidence,
    embedding: row.embedding ? decodeEmbedding(row.embedding) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    sourceCount: row.source_count,
    importance: row.importance,
    decay: row.decay,
    version: row.version,
    labels: JSON.parse(row.labels),
    tags: JSON.parse(row.tags),
  };
}

function toSummary(unit: Unit): UnitSummary {
  return {
    id: unit.id,
    type: unit.type,
    form: unit.form,
    title: unit.title,
    summary: unit.summary,
    tags: unit.tags,
    importance: unit.importance,
    decay: unit.decay,
    status: unit.status,
    updatedAt: unit.updatedAt,
  };
}

function rowToLink(row: LinkRow): Link {
  return {
    id: row.id,
    sourceUnitId: row.source_unit_id,
    targetUnitId: row.target_unit_id,
    relation: row.relation,
    reason: row.reason,
    confidence: row.confidence,
    auto: row.auto === 1,
    createdAt: row.created_at,
  };
}

function linkToRow(link: Link): LinkRow {
  return {
    id: link.id,
    source_unit_id: link.sourceUnitId,
    target_unit_id: link.targetUnitId,
    relation: link.relation,
    reason: link.reason,
    confidence: link.confidence,
    auto: link.auto ? 1 : 0,
    created_at: link.createdAt,
  };
}

function rowToTrace(row: TraceRow): Trace {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    title: row.title,
    content: row.content,
    contentType: row.content_type,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

function rowToSource(row: SourceRow): Source {
  return {
    id: row.id,
    uri: row.uri ?? undefined,
    title: row.title,
    kind: row.kind,
    contentHash: row.content_hash,
    contentLength: row.content_length,
    createdAt: row.created_at,
  };
}

function rowToCitation(row: CitationRow): UnitSource {
  return {
    unitId: row.unit_id,
    sourceId: row.source_id,
    span: row.span ?? undefined,
    assertedAt: row.asserted_at,
  };
}

function rowToVersion(row: VersionRow): Version {
  return {
    id: row.id,
    unitId: row.unit_id,
    version: row.version,
    snapshot: JSON.parse(row.snapshot) as Version['snapshot'],
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function rowToScenario(row: ScenarioRow): Scenario {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    sourceUnitIds: JSON.parse(row.source_unit_ids) as string[],
    status: row.status,
    version: row.version,
    heat: row.heat ?? 0,
    lastHitAt: row.last_hit_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastConsolidatedAt: row.last_consolidated_at ?? undefined,
  };
}

function scenarioToRow(scenario: Scenario, workspaceId: string): Record<string, unknown> {
  return {
    id: scenario.id,
    workspace_id: workspaceId,
    title: scenario.title,
    summary: scenario.summary,
    content: scenario.content,
    tags: JSON.stringify(scenario.tags),
    source_unit_ids: JSON.stringify(scenario.sourceUnitIds),
    status: scenario.status,
    version: scenario.version,
    heat: scenario.heat ?? 0,
    last_hit_at: scenario.lastHitAt ?? null,
    created_at: scenario.createdAt,
    updated_at: scenario.updatedAt,
    last_consolidated_at: scenario.lastConsolidatedAt ?? null,
  };
}

function rowToPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    content: row.content,
    body: row.body,
    trigger: row.trigger,
    tags: JSON.parse(row.tags) as string[],
    sourceUnitIds: JSON.parse(row.source_unit_ids) as string[],
    status: row.status,
    visibility: row.visibility ?? 'workspace',
    boundAgents: JSON.parse(row.bound_agents ?? '[]') as string[],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAssetVersion(row: AssetVersionRow): AssetVersion {
  return {
    id: row.id,
    assetId: row.asset_id,
    version: row.version,
    snapshot: JSON.parse(row.snapshot) as Omit<Asset, 'id'>,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function assetToRow(asset: Asset, workspaceId: string): Record<string, unknown> {
  return {
    id: asset.id,
    workspace_id: workspaceId,
    kind: asset.kind,
    name: asset.name,
    description: asset.description,
    content: asset.content,
    body: asset.body,
    trigger: asset.trigger,
    tags: JSON.stringify(asset.tags),
    source_unit_ids: JSON.stringify(asset.sourceUnitIds),
    status: asset.status,
    visibility: asset.visibility ?? 'workspace',
    bound_agents: JSON.stringify(asset.boundAgents ?? []),
    version: asset.version,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
  };
}

// --- Storage -------------------------------------------------------------------

export class SqliteStorage implements Storage {
  private readonly db: SqliteDatabase;
  private readonly secret?: string;

  constructor(db: SqliteDatabase, secret?: string) {
    this.db = db;
    this.secret = secret;
  }

  // --- AI providers (instance-global) ---

  private rowToProvider(row: ProviderRow): AiProvider {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseUrl: row.base_url,
      model: row.model,
      embeddingModel: row.embedding_model || undefined,
      embeddingBaseUrl: row.embedding_base_url || undefined,
      embeddingApiKey: decryptProviderKey(row.embedding_api_key, this.secret) || undefined,
      apiKey: decryptProviderKey(row.api_key, this.secret) || undefined,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listProviders(): Promise<AiProvider[]> {
    const rows = this.db
      .prepare('SELECT * FROM ai_providers ORDER BY created_at ASC')
      .all() as ProviderRow[];
    return rows.map((r) => this.rowToProvider(r));
  }

  async getActiveProvider(): Promise<AiProvider | null> {
    const row = this.db
      .prepare('SELECT * FROM ai_providers WHERE is_active = 1 LIMIT 1')
      .get() as ProviderRow | undefined;
    return row ? this.rowToProvider(row) : null;
  }

  async upsertProvider(provider: AiProviderInput & { id: string }): Promise<AiProvider> {
    const existing = this.db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(provider.id) as
      | ProviderRow
      | undefined;
    const now = new Date().toISOString();
    const storedKey = provider.apiKey
      ? encryptProviderKey(provider.apiKey, this.secret)
      : existing?.api_key ?? '';
    const storedEmbeddingKey = provider.embeddingApiKey
      ? encryptProviderKey(provider.embeddingApiKey, this.secret)
      : existing?.embedding_api_key ?? '';
    this.db
      .prepare(
        `INSERT INTO ai_providers (id, name, kind, base_url, model, embedding_model, embedding_base_url, embedding_api_key, api_key, is_active, created_at, updated_at)
         VALUES (@id, @name, @kind, @base_url, @model, @embedding_model, @embedding_base_url, @embedding_api_key, @api_key, @is_active, @created_at, @updated_at)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           base_url = excluded.base_url,
           model = excluded.model,
           embedding_model = excluded.embedding_model,
           embedding_base_url = excluded.embedding_base_url,
           embedding_api_key = excluded.embedding_api_key,
           api_key = excluded.api_key,
           is_active = excluded.is_active,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        base_url: provider.baseUrl,
        model: provider.model,
        embedding_model: provider.embeddingModel ?? '',
        embedding_base_url: provider.embeddingBaseUrl ?? '',
        embedding_api_key: storedEmbeddingKey,
        api_key: storedKey,
        is_active: provider.isActive ? 1 : existing?.is_active ?? 0,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
    const row = this.db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(provider.id) as ProviderRow;
    return this.rowToProvider(row);
  }

  async deleteProvider(id: string): Promise<void> {
    this.db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id);
  }

  async setActiveProvider(id: string | null): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('UPDATE ai_providers SET is_active = 0').run();
      if (id) {
        this.db
          .prepare('UPDATE ai_providers SET is_active = 1, updated_at = ? WHERE id = ?')
          .run(new Date().toISOString(), id);
      }
    })();
  }

  // --- Units ---

  async createUnit(unit: Unit): Promise<void> {
    const row = unitToRow(unit) as unknown as Record<string, unknown>;
    row.workspace_id = currentWorkspaceId();
    // INSERT may not include workspace_id column yet in SQL string — use extended insert when available.
    try {
      this.db
        .prepare(
          `INSERT INTO units (
            id, type, form, title, summary, body, status, quality, confidence,
            embedding, created_at, updated_at, valid_from, valid_to, source_count,
            importance, decay, version, labels, tags, workspace_id
          ) VALUES (
            @id, @type, @form, @title, @summary, @body, @status, @quality, @confidence,
            @embedding, @created_at, @updated_at, @valid_from, @valid_to, @source_count,
            @importance, @decay, @version, @labels, @tags, @workspace_id
          )`,
        )
        .run(row);
    } catch {
      this.db.prepare(INSERT_UNIT).run(unitToRow(unit));
    }
  }

  async getUnit(id: UnitId): Promise<Unit | null> {
    const ws = currentWorkspaceId();
    const row = this.db
      .prepare('SELECT * FROM units WHERE id = ? AND workspace_id = ?')
      .get(id, ws) as UnitRow | undefined;
    return row ? rowToUnit(row) : null;
  }

  async updateUnit(unit: Unit): Promise<void> {
    this.db.prepare(UPDATE_UNIT).run(unitToRow(unit));
  }

  async deleteUnit(id: UnitId): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM unit_sources WHERE unit_id = ?').run(id);
      this.db.prepare('DELETE FROM links WHERE source_unit_id = ? OR target_unit_id = ?').run(id, id);
      this.db.prepare('DELETE FROM versions WHERE unit_id = ?').run(id);
      this.db.prepare('DELETE FROM unit_tags WHERE unit_id = ?').run(id);
      this.db.prepare('DELETE FROM units WHERE id = ?').run(id);
    })();
  }

  async listUnits(filter: {
    type?: UnitType;
    status?: Unit['status'];
    tag?: string;
    limit?: number;
    offset?: number;
    includeBody?: boolean;
  } = {}): Promise<UnitSummary[]> {
    const conds: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.type) {
      conds.push('type = @type');
      params.type = filter.type;
    }
    if (filter.status) {
      conds.push('status = @status');
      params.status = filter.status;
    }
    if (filter.tag) {
      conds.push("EXISTS (SELECT 1 FROM json_each(units.tags) WHERE json_each.value = @tag)");
      params.tag = filter.tag;
    }
    conds.unshift('workspace_id = @workspace_id');
    params.workspace_id = currentWorkspaceId();
    let sql = 'SELECT * FROM units';
    if (conds.length > 0) sql += ` WHERE ${conds.join(' AND ')}`;
    sql += ' ORDER BY updated_at DESC';
    if (typeof filter.limit === 'number') {
      sql += ' LIMIT @limit';
      params.limit = filter.limit;
    }
    if (typeof filter.offset === 'number') {
      sql += ' OFFSET @offset';
      params.offset = filter.offset;
    }
    const rows = this.db.prepare(sql).all(params) as UnitRow[];
    return rows.map((r) => toSummary(rowToUnit(r)));
  }

  /** All active (non-archived) units with their embeddings parsed. When a
   *  `limit` is given, returns the freshest N units — link generation only
   *  needs a bounded candidate set, so callers avoid loading every vector. */
  async allUnitsWithEmbeddings(limit?: number): Promise<Unit[]> {
    const sql =
      limit && limit > 0
        ? "SELECT * FROM units WHERE status != 'archived' AND workspace_id = ? ORDER BY updated_at DESC LIMIT ?"
        : "SELECT * FROM units WHERE status != 'archived' AND workspace_id = ?";
    const params = limit && limit > 0 ? [currentWorkspaceId(), limit] : [currentWorkspaceId()];
    const rows = this.db.prepare(sql).all(params) as UnitRow[];
    return rows.map(rowToUnit);
  }

  /** All active (non-archived) units without the (large) embedding payloads.
   *  Use for list/graph/stats paths that never touch vectors — avoids
   *  parsing megabytes of embedding data per request. */
  async allUnits(): Promise<Unit[]> {
    const rows = this.db
      .prepare(
        `SELECT ${LIGHT_UNIT_COLUMNS} FROM units WHERE status != 'archived' AND workspace_id = ?`,
      )
      .all(currentWorkspaceId()) as Array<Omit<UnitRow, 'embedding'>>;
    return rows.map((r) => rowToUnit({ ...r, embedding: null }));
  }

  /** Bulk update inside a single transaction (used by consolidation). */
  async updateUnits(units: Unit[]): Promise<void> {
    if (units.length === 0) return;
    const stmt = this.db.prepare(UPDATE_UNIT_LIGHT);
    this.db.transaction((list: Unit[]) => {
      for (const unit of list) {
        stmt.run({
          id: unit.id,
          form: unit.form,
          status: unit.status,
          importance: unit.importance,
          decay: unit.decay,
        });
      }
    })(units);
  }

  // --- Links ---

  async createLink(link: Link): Promise<void> {
    const row = { ...linkToRow(link), workspace_id: currentWorkspaceId() };
    this.db
      .prepare(
        `INSERT INTO links (id, source_unit_id, target_unit_id, relation, reason, confidence, auto, created_at, workspace_id)
         VALUES (@id, @source_unit_id, @target_unit_id, @relation, @reason, @confidence, @auto, @created_at, @workspace_id)`,
      )
      .run(row);
  }

  async upsertLink(link: Link): Promise<void> {
    const row = { ...linkToRow(link), workspace_id: currentWorkspaceId() };
    this.db
      .prepare(
        `INSERT INTO links (id, source_unit_id, target_unit_id, relation, reason, confidence, auto, created_at, workspace_id)
         VALUES (@id, @source_unit_id, @target_unit_id, @relation, @reason, @confidence, @auto, @created_at, @workspace_id)
         ON CONFLICT (source_unit_id, target_unit_id, relation) DO UPDATE SET
           id = excluded.id,
           reason = excluded.reason,
           confidence = excluded.confidence,
           auto = excluded.auto,
           created_at = excluded.created_at`,
      )
      .run(row);
  }

  /** Batch link insert inside a single transaction (used by link generation). */
  async createLinks(links: Link[]): Promise<void> {
    if (links.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO links (id, source_unit_id, target_unit_id, relation, reason, confidence, auto, created_at, workspace_id)
       VALUES (@id, @source_unit_id, @target_unit_id, @relation, @reason, @confidence, @auto, @created_at, @workspace_id)`,
    );
    this.db.transaction((list: Link[]) => {
      for (const link of list) stmt.run({ ...linkToRow(link), workspace_id: currentWorkspaceId() });
    })(links);
  }

  async getLinksForUnit(unitId: UnitId): Promise<Link[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM links WHERE workspace_id = ? AND (source_unit_id = ? OR target_unit_id = ?) ORDER BY created_at DESC`,
      )
      .all(currentWorkspaceId(), unitId, unitId) as LinkRow[];
    return rows.map(rowToLink);
  }

  async allLinks(): Promise<Link[]> {
    const rows = this.db
      .prepare('SELECT * FROM links WHERE workspace_id = ?')
      .all(currentWorkspaceId()) as LinkRow[];
    return rows.map(rowToLink);
  }

  async deleteLink(id: string): Promise<void> {
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id);
  }

  async deleteLinks(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const del = this.db.prepare('DELETE FROM links WHERE id = ?');
    this.db.transaction((list: string[]) => {
      for (const id of list) del.run(id);
    })(ids);
  }

  // --- Traces / sessions ---

  async createTrace(trace: Trace): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO traces (id, session_id, title, content, content_type, token_count, created_at, workspace_id)
         VALUES (@id, @session_id, @title, @content, @content_type, @token_count, @created_at, @workspace_id)`,
      )
      .run({
        id: trace.id,
        session_id: trace.sessionId ?? null,
        title: trace.title,
        content: trace.content,
        content_type: trace.contentType,
        token_count: trace.tokenCount,
        created_at: trace.createdAt,
        workspace_id: currentWorkspaceId(),
      });
  }

  async getTrace(id: TraceId): Promise<Trace | null> {
    const row = this.db
      .prepare('SELECT * FROM traces WHERE id = ? AND workspace_id = ?')
      .get(id, currentWorkspaceId()) as TraceRow | undefined;
    return row ? rowToTrace(row) : null;
  }

  async listTraces(filter: { sessionId?: SessionId; limit?: number } = {}): Promise<Trace[]> {
    const conds: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.sessionId !== undefined) {
      conds.push('session_id = @sessionId');
      params.sessionId = filter.sessionId;
    }
    let sql = 'SELECT * FROM traces';
    if (conds.length > 0) sql += ` WHERE ${conds.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC';
    if (typeof filter.limit === 'number') {
      sql += ' LIMIT @limit';
      params.limit = filter.limit;
    }
    const rows = this.db.prepare(sql).all(params) as TraceRow[];
    return rows.map(rowToTrace);
  }

  async upsertSession(session: { id: SessionId; label: string; agent?: string }): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, label, agent, created_at, updated_at, workspace_id)
         VALUES (@id, @label, @agent, @created_at, @updated_at, @workspace_id)
         ON CONFLICT (id) DO UPDATE SET
           label = excluded.label,
           agent = excluded.agent,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: session.id,
        label: session.label,
        agent: session.agent ?? null,
        created_at: now,
        updated_at: now,
        workspace_id: currentWorkspaceId(),
      });
  }

  private getSessionRow(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  /** Read a session row (exposed for tests/consumers). */
  async getSession(id: SessionId): Promise<Session | null> {
    const row = this.getSessionRow(id);
    if (!row) return null;
    return {
      id: row.id,
      label: row.label,
      agent: row.agent ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // --- Sources / citations ---

  async upsertSource(source: Source): Promise<Source> {
    this.db
      .prepare(
        `INSERT INTO sources (id, uri, title, kind, content_hash, content_length, created_at, workspace_id)
         VALUES (@id, @uri, @title, @kind, @content_hash, @content_length, @created_at, @workspace_id)
         ON CONFLICT (id) DO UPDATE SET
           uri = excluded.uri,
           title = excluded.title,
           kind = excluded.kind,
           content_hash = excluded.content_hash,
           content_length = excluded.content_length`,
      )
      .run({
        id: source.id,
        uri: source.uri ?? null,
        title: source.title,
        kind: source.kind,
        content_hash: source.contentHash,
        content_length: source.contentLength,
        workspace_id: currentWorkspaceId(),
        created_at: source.createdAt,
      });
    return source;
  }

  async getSource(id: string): Promise<Source | null> {
    const row = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
    return row ? rowToSource(row) : null;
  }

  async sourcesByIds(ids: string[]): Promise<Source[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM sources WHERE id IN (${placeholders})`)
      .all(...ids) as SourceRow[];
    return rows.map(rowToSource);
  }

  async addCitation(citation: UnitSource): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO unit_sources (unit_id, source_id, span, asserted_at)
         VALUES (@unit_id, @source_id, @span, @asserted_at)`,
      )
      .run({
        unit_id: citation.unitId,
        source_id: citation.sourceId,
        span: citation.span ?? null,
        asserted_at: citation.assertedAt,
      });
  }

  async getCitationsForUnit(unitId: UnitId): Promise<UnitSource[]> {
    const rows = this.db
      .prepare('SELECT * FROM unit_sources WHERE unit_id = ?')
      .all(unitId) as CitationRow[];
    return rows.map(rowToCitation);
  }

  async distinctSourceIdsForUnit(unitId: UnitId): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT DISTINCT source_id FROM unit_sources WHERE unit_id = ?')
      .all(unitId) as Array<{ source_id: string }>;
    return rows.map((r) => r.source_id);
  }

  /** Distinct source counts for every unit in one pass (avoids N+1 queries). */
  async sourceCountsByUnit(): Promise<Map<string, number>> {
    const rows = this.db
      .prepare('SELECT unit_id, COUNT(DISTINCT source_id) AS c FROM unit_sources GROUP BY unit_id')
      .all() as Array<{ unit_id: string; c: number }>;
    return new Map(rows.map((r) => [r.unit_id, Number(r.c)]));
  }

  // --- Versions ---

  async createVersion(version: Version): Promise<VersionId> {
    this.db
      .prepare(
        `INSERT INTO versions (id, unit_id, version, snapshot, reason, created_at)
         VALUES (@id, @unit_id, @version, @snapshot, @reason, @created_at)`,
      )
      .run({
        id: version.id,
        unit_id: version.unitId,
        version: version.version,
        snapshot: JSON.stringify(version.snapshot),
        reason: version.reason,
        created_at: version.createdAt,
      });
    return version.id;
  }

  async listVersions(unitId: UnitId): Promise<Version[]> {
    const rows = this.db
      .prepare('SELECT * FROM versions WHERE unit_id = ? ORDER BY version ASC')
      .all(unitId) as VersionRow[];
    return rows.map(rowToVersion);
  }

  // --- L2 scenarios ---

  async listScenarios(
    filter: { tag?: string; status?: Scenario['status']; limit?: number; sort?: 'updated' | 'heat' } = {},
  ): Promise<Scenario[]> {
    const ws = currentWorkspaceId();
    const conds = ['workspace_id = ?'];
    const params: unknown[] = [ws];
    if (filter.status) {
      conds.push('status = ?');
      params.push(filter.status);
    }
    if (filter.tag) {
      conds.push('tags LIKE ?');
      params.push(`%"${filter.tag}"%`);
    }
    const orderBy = filter.sort === 'heat' ? 'heat DESC, updated_at DESC' : 'updated_at DESC';
    let sql = `SELECT * FROM scenarios WHERE ${conds.join(' AND ')} ORDER BY ${orderBy}`;
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as ScenarioRow[];
    return rows.map(rowToScenario);
  }

  async getScenario(id: ScenarioId): Promise<Scenario | null> {
    const row = this.db
      .prepare('SELECT * FROM scenarios WHERE id = ? AND workspace_id = ?')
      .get(id, currentWorkspaceId()) as ScenarioRow | undefined;
    return row ? rowToScenario(row) : null;
  }

  async createScenario(scenario: Scenario): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO scenarios (
           id, workspace_id, title, summary, content, tags, source_unit_ids,
           status, version, heat, last_hit_at, created_at, updated_at, last_consolidated_at
         ) VALUES (
           @id, @workspace_id, @title, @summary, @content, @tags, @source_unit_ids,
           @status, @version, @heat, @last_hit_at, @created_at, @updated_at, @last_consolidated_at
         )`,
      )
      .run(scenarioToRow(scenario, currentWorkspaceId()));
  }

  async updateScenario(scenario: Scenario): Promise<void> {
    this.db
      .prepare(
        `UPDATE scenarios SET
           title = @title, summary = @summary, content = @content, tags = @tags,
           source_unit_ids = @source_unit_ids, status = @status, version = @version,
           heat = @heat, last_hit_at = @last_hit_at,
           updated_at = @updated_at, last_consolidated_at = @last_consolidated_at
         WHERE id = @id AND workspace_id = @workspace_id`,
      )
      .run(scenarioToRow(scenario, currentWorkspaceId()));
  }

  async bumpScenarioHeat(id: ScenarioId): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scenarios SET heat = heat + 1, last_hit_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      )
      .run(now, now, id, currentWorkspaceId());
  }

  async deleteScenario(id: ScenarioId): Promise<void> {
    this.db
      .prepare('DELETE FROM scenarios WHERE id = ? AND workspace_id = ?')
      .run(id, currentWorkspaceId());
  }

  // --- L3 persona ---

  async getPersona(): Promise<Persona | null> {
    const row = this.db
      .prepare('SELECT * FROM personas WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(currentWorkspaceId()) as PersonaRow | undefined;
    return row ? rowToPersona(row) : null;
  }

  async upsertPersona(persona: Persona): Promise<void> {
    const existing = this.db
      .prepare('SELECT * FROM personas WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(currentWorkspaceId()) as PersonaRow | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE personas SET content = ?, version = ?, updated_at = ? WHERE id = ?')
        .run(persona.content, persona.version, persona.updatedAt, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO personas (id, workspace_id, content, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(persona.id, currentWorkspaceId(), persona.content, persona.version, persona.createdAt, persona.updatedAt);
    }
  }

  // --- Assets ---

  async listAssets(filter: { kind?: Asset['kind']; status?: Asset['status']; limit?: number } = {}): Promise<Asset[]> {
    const ws = currentWorkspaceId();
    const conds = ['workspace_id = ?'];
    const params: unknown[] = [ws];
    if (filter.kind) {
      conds.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.status) {
      conds.push('status = ?');
      params.push(filter.status);
    }
    let sql = `SELECT * FROM assets WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC`;
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as AssetRow[];
    return rows.map(rowToAsset);
  }

  /**
   * Assets a given agent may discover and call (Tencent-style routing):
   * published assets whose visibility is `public`/`workspace`, or whose
   * `boundAgents` explicitly includes the agent key.
   */
  async listEquipped(agent: string): Promise<Asset[]> {
    const ws = currentWorkspaceId();
    const agentKey = `%"${agent.replaceAll('"', '')}"%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM assets
         WHERE workspace_id = ?
           AND status = 'published'
           AND (visibility IN ('public', 'workspace')
                OR bound_agents LIKE ?)
         ORDER BY updated_at DESC`,
      )
      .all(ws, agentKey) as AssetRow[];
    return rows.map(rowToAsset);
  }

  async getAsset(id: AssetId): Promise<Asset | null> {
    const row = this.db
      .prepare('SELECT * FROM assets WHERE id = ? AND workspace_id = ?')
      .get(id, currentWorkspaceId()) as AssetRow | undefined;
    return row ? rowToAsset(row) : null;
  }

  async listAssetVersions(id: AssetId): Promise<AssetVersion[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM asset_versions
         WHERE asset_id = ? AND workspace_id = ?
         ORDER BY version DESC, created_at DESC`,
      )
      .all(id, currentWorkspaceId()) as AssetVersionRow[];
    return rows.map(rowToAssetVersion);
  }

  async snapshotAssetVersion(asset: Asset, reason: string): Promise<void> {
    const { id, ...rest } = asset;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO asset_versions (id, asset_id, workspace_id, version, snapshot, reason, created_at)
         VALUES (@id, @asset_id, @workspace_id, @version, @snapshot, @reason, @created_at)`,
      )
      .run({
        id: `av_${randomUUID()}`,
        asset_id: id,
        workspace_id: currentWorkspaceId(),
        version: asset.version,
        snapshot: JSON.stringify(rest),
        reason,
        created_at: createdAt,
      });
  }

  async createAsset(asset: Asset): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO assets (
           id, workspace_id, kind, name, description, content, body, trigger,
           tags, source_unit_ids, status, visibility, bound_agents, version, created_at, updated_at
         ) VALUES (
           @id, @workspace_id, @kind, @name, @description, @content, @body, @trigger,
           @tags, @source_unit_ids, @status, @visibility, @bound_agents, @version, @created_at, @updated_at
         )`,
      )
      .run(assetToRow(asset, currentWorkspaceId()));
  }

  async updateAsset(asset: Asset): Promise<void> {
    this.db
      .prepare(
        `UPDATE assets SET
           kind = @kind, name = @name, description = @description, content = @content,
           body = @body, trigger = @trigger, tags = @tags, source_unit_ids = @source_unit_ids,
           status = @status, visibility = @visibility, bound_agents = @bound_agents,
           version = @version, updated_at = @updated_at
         WHERE id = @id AND workspace_id = @workspace_id`,
      )
      .run(assetToRow(asset, currentWorkspaceId()));
  }

  async deleteAsset(id: AssetId): Promise<void> {
    // Version snapshots reference the asset; remove them first (FK is enforced).
    this.db
      .prepare('DELETE FROM asset_versions WHERE asset_id = ? AND workspace_id = ?')
      .run(id, currentWorkspaceId());
    this.db
      .prepare('DELETE FROM assets WHERE id = ? AND workspace_id = ?')
      .run(id, currentWorkspaceId());
  }

  // --- Stats ---

  private async scalarCount(sql: string, ...params: unknown[]): Promise<number> {
    const row = this.db.prepare(sql).get(...params) as { c: number };
    return row.c;
  }

  async counts(): Promise<StatsCounts> {
    const ws = currentWorkspaceId();
    const units = await this.scalarCount('SELECT COUNT(*) AS c FROM units WHERE workspace_id = ?', ws);
    const unitsActive = await this.scalarCount(
      "SELECT COUNT(*) AS c FROM units WHERE status != 'archived' AND workspace_id = ?",
      ws,
    );
    const crystals = await this.scalarCount(
      "SELECT COUNT(*) AS c FROM units WHERE form = 'crystal' AND workspace_id = ?",
      ws,
    );
    const traces = await this.scalarCount('SELECT COUNT(*) AS c FROM traces WHERE workspace_id = ?', ws);
    const links = await this.scalarCount('SELECT COUNT(*) AS c FROM links WHERE workspace_id = ?', ws);
    const sources = await this.scalarCount('SELECT COUNT(*) AS c FROM sources WHERE workspace_id = ?', ws);
    const sessions = await this.scalarCount('SELECT COUNT(*) AS c FROM sessions WHERE workspace_id = ?', ws);
    const pendingReview = await this.scalarCount(
      "SELECT COUNT(*) AS c FROM units WHERE status = 'pending' AND workspace_id = ?",
      ws,
    );
    const scenarios = await this.scalarCount(
      "SELECT COUNT(*) AS c FROM scenarios WHERE workspace_id = ? AND status != 'archived'",
      ws,
    );
    const assets = await this.scalarCount('SELECT COUNT(*) AS c FROM assets WHERE workspace_id = ?', ws);
    return { units, unitsActive, crystals, traces, links, sources, sessions, pendingReview, scenarios, assets };
  }

  async byTypeCounts(): Promise<Partial<Record<UnitType, number>>> {
    const rows = this.db
      .prepare('SELECT type, COUNT(*) AS c FROM units WHERE workspace_id = ? GROUP BY type')
      .all(currentWorkspaceId()) as Array<{
      type: UnitType;
      c: number;
    }>;
    const result: Partial<Record<UnitType, number>> = {};
    for (const row of rows) result[row.type] = row.c;
    return result;
  }

  async perDay(limit?: number): Promise<Array<{ day: string; units: number; traces: number }>> {
    const ws = currentWorkspaceId();
    const base = `
      SELECT day, SUM(c_units) AS units, SUM(c_traces) AS traces FROM (
        SELECT date(created_at) AS day, 1 AS c_units, 0 AS c_traces FROM units WHERE workspace_id = ?
        UNION ALL
        SELECT date(created_at) AS day, 0 AS c_units, 1 AS c_traces FROM traces WHERE workspace_id = ?
      ) GROUP BY day ORDER BY day DESC
    `;
    const rows = (
      limit && limit > 0
        ? this.db.prepare(`${base} LIMIT ?`).all(ws, ws, limit)
        : this.db.prepare(base).all(ws, ws)
    ) as Array<{ day: string; units: number; traces: number }>;
    return rows.map((r) => ({ day: r.day, units: r.units, traces: r.traces }));
  }

  async dbHealth(): Promise<{ ok: boolean; status: string; journal: string; units: number }> {
    // Runs on the primary connection on purpose: a second connection doing
    // `PRAGMA journal_mode` can fail with SQLITE_IOERR while the main writer
    // is live, notably on virtiofs bind mounts (macOS Docker).
    let status = 'unknown';
    let journal = 'unknown';
    let units = 0;
    try {
      status = ensureSqliteHealthy(this.db);
      journal = String(this.db.pragma('journal_mode', { simple: true }));
      units = (this.db.prepare('SELECT COUNT(*) AS c FROM units').get() as { c: number }).c;
    } catch (e) {
      status = e instanceof Error ? e.message : String(e);
    }
    return { ok: status === 'ok' || status === 'ok-after-fts-rebuild', status, journal, units };
  }

  // --- Audit / jobs ---

  async recordJob(job: {
    kind: string;
    status: string;
    meta?: Record<string, unknown>;
    error?: string;
  }): Promise<string> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, status, meta, error, created_at)
         VALUES (@id, @kind, @status, @meta, @error, @created_at)`,
      )
      .run({
        id,
        kind: job.kind,
        status: job.status,
        meta: job.meta ? JSON.stringify(job.meta) : null,
        error: job.error ?? null,
        created_at: new Date().toISOString(),
      });
    return id;
  }

  async markJob(
    id: string,
    status: string,
    details?: { error?: string; finishedAt?: IsoDate },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE jobs SET
           status = @status,
           error = COALESCE(@error, error),
           finished_at = COALESCE(@finished_at, finished_at)
         WHERE id = @id`,
      )
      .run({
        id,
        status,
        error: details?.error ?? null,
        finished_at: details?.finishedAt ?? null,
      });
  }

  /** Read a job row (exposed for tests/consumers). */
  async getJob(id: string): Promise<Job | null> {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(id) as (JobRow) | undefined;
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status as Job['status'],
      meta: row.meta ? JSON.parse(row.meta) : undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      finishedAt: row.finished_at ?? undefined,
    };
  }


  // --- Activity feed ---

  async recordEvent(event: {
    kind: string;
    summary: string;
    actor?: string;
    meta?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO events (id, kind, summary, actor, meta, created_at, workspace_id)
         VALUES (@id, @kind, @summary, @actor, @meta, @created_at, @workspace_id)`,
      )
      .run({
        id,
        kind: event.kind,
        summary: event.summary,
        actor: event.actor ?? null,
        meta: event.meta ? JSON.stringify(event.meta) : null,
        created_at: new Date().toISOString(),
        workspace_id: currentWorkspaceId(),
      });
    return id;
  }

  async listEvents(filter: ActivityFilter = {}): Promise<ActivityEvent[]> {
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 500) : 50;
    const params: unknown[] = [];
    let sql = 'SELECT * FROM events';
    const where: string[] = ['workspace_id = ?'];
    params.push(currentWorkspaceId());
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.before) {
      where.push('created_at < ?');
      params.push(filter.before);
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      kind: string;
      summary: string;
      actor: string | null;
      meta: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      summary: row.summary,
      actor: row.actor ?? undefined,
      meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined,
      createdAt: row.created_at,
    }));
  }

  // --- Real pipeline lifecycle ---

  async recordPipelineStage(stage: {
    cardId: string;
    cardTitle: string;
    kind: string;
    actor?: string;
    meta?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pipeline_stages (id, card_id, card_title, kind, actor, meta, created_at, workspace_id)
         VALUES (@id, @card_id, @card_title, @kind, @actor, @meta, @created_at, @workspace_id)`,
      )
      .run({
        id,
        card_id: stage.cardId,
        card_title: stage.cardTitle,
        kind: stage.kind,
        actor: stage.actor ?? null,
        meta: stage.meta ? JSON.stringify(stage.meta) : null,
        created_at: new Date().toISOString(),
        workspace_id: currentWorkspaceId(),
      });
    return id;
  }

  async listPipeline(limit = 50): Promise<PipelineStage[]> {
    const cap = Math.min(Math.max(1, limit), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_stages
         WHERE workspace_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(currentWorkspaceId(), cap) as Array<{
      id: string;
      card_id: string;
      card_title: string;
      kind: string;
      actor: string | null;
      meta: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      cardId: row.card_id,
      cardTitle: row.card_title,
      kind: row.kind,
      actor: row.actor ?? undefined,
      meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined,
      createdAt: row.created_at,
    }));
  }

  // --- Lifetime ---

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  meta: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** Wrap an already-open, migrated database in a `Storage` implementation. */
export function createSqliteStorage(db: SqliteDatabase, secret?: string): Storage {
  return new SqliteStorage(db, secret);
}

/** Open (creating/migrating if needed) a database at `dbPath` and wrap it. */
export function createSqliteStorageFromPath(dbPath: string, secret?: string): Promise<Storage> {
  const db = new Database(dbPath);
  configureSqliteConnection(db);
  migrate(db);
  const health = ensureSqliteHealthy(db);
  if (health !== 'ok' && health !== 'ok-after-fts-rebuild') {
    console.warn(`[amem/db] sqlite integrity warning: ${health}`);
  } else if (health === 'ok-after-fts-rebuild') {
    console.warn('[amem/db] rebuilt units_fts after integrity issue');
  }
  return Promise.resolve(new SqliteStorage(db, secret));
}
