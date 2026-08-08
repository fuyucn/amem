/**
 * Amem domain contract.
 *
 * This file is the single source of truth for the domain model. It is imported
 * by `db`, `server`, `mcp`, and `web` via the `@amem/core` package. Keep changes
 * backwards compatible; bump thoughtfully.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------
export type UnitId = string;
export type TraceId = string;
export type SourceId = string;
export type LinkId = string;
export type SessionId = string;
export type VersionId = string;
export type JobId = string;
export type ScenarioId = string;
export type AssetId = string;

export type IsoDate = string; // ISO-8601

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
/** Atomic knowledge unit types. */
export const UNIT_TYPES = [
  'fact',
  'decision',
  'plan',
  'procedure',
  'preference',
  'concept',
  'lesson',
  'question',
] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export type UnitStatus = 'pending' | 'reviewed' | 'archived' | 'merged' | 'flagged';

/** The three memory forms: episodic -> semantic consolidation. */
export type MemoryForm = 'trace' | 'unit' | 'crystal';

/**
 * Memory layering (TencentDB-Agent-Memory style L0-L3).
 * Amem: L0 = Trace (raw), L1 = Unit/Crystal (atoms), L2 = Scenario
 * (project/scenario knowledge block), L3 = Persona (long-term profile).
 */
export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3';

export type ScenarioStatus = 'active' | 'stale' | 'archived';

export type AssetKind = 'skill' | 'wiki' | 'codegraph' | 'prompt';

export type AssetStatus = 'draft' | 'reviewed' | 'published' | 'archived';

/**
 * Who may discover and call an asset (TencentDB-Agent-Memory style routing).
 * - `workspace` (default): any agent in the workspace can use it.
 * - `public`: any agent on the instance can use it.
 * - `private`: only the agents listed in `boundAgents` can use it.
 * - `team`: only `boundAgents` plus workspace agents with an explicit binding.
 */
export type AssetVisibility = 'private' | 'workspace' | 'team' | 'public';

export const LINK_RELATIONS = [
  'supports',
  'contradicts',
  'part_of',
  'extends',
  'precedes',
  'references',
  'related_to',
  'supersedes',
  'caused_by',
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export type SourceKind = 'url' | 'file' | 'transcript' | 'manual' | 'note';

export type EmbeddingMode = 'api' | 'offline';

export type NodeCluster = { id: string; label: string; unitIds: UnitId[] };

// ---------------------------------------------------------------------------
// AI providers (LLM endpoints managed from Settings; instance-global)
// ---------------------------------------------------------------------------
export type AiProviderKind = 'openai_compatible';

export interface AiProvider {
  id: string;
  name: string;
  kind: AiProviderKind;
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  model: string;
  /** Optional separate embeddings model; falls back to `model` when unset. */
  embeddingModel?: string;
  /** Optional separate embeddings endpoint (e.g. Ollama/OpenAI) when the chat provider has no /embeddings route. */
  embeddingBaseUrl?: string;
  /** API key for the separate embeddings endpoint; never serialized by the API. */
  embeddingApiKey?: string;
  /** Decrypted only at the storage boundary; never serialized by the API. */
  apiKey?: string;
  isActive: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export type AiProviderInput = Pick<
  AiProvider,
  'name' | 'kind' | 'baseUrl' | 'model' | 'apiKey' | 'embeddingModel' | 'embeddingBaseUrl' | 'embeddingApiKey'
> &
  Partial<Pick<AiProvider, 'id' | 'isActive'>>;

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------
export interface Embedding {
  dims: number;
  values: number[];
}

export interface Unit {
  id: UnitId;
  /** Atomic knowledge of a given type. */
  type: UnitType;
  /** unit | crystal (crystal = cross-validated). */
  form: MemoryForm;
  title: string;
  /** one-line description. */
  summary: string;
  /** full markdown body. */
  body: string;
  tags: string[];
  labels: Record<string, string | number | boolean>;
  status: UnitStatus;
  /** 0..1 extraction/curation quality. */
  quality: number;
  /** 0..1 retrieval confidence. */
  confidence: number;
  embedding?: Embedding;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  /** bi-temporal: valid window (optional). */
  validFrom?: IsoDate;
  validTo?: IsoDate;
  /** number of independent sources citing this unit. */
  sourceCount: number;
  /** 0..1 graph importance (community/centrality). */
  importance: number;
  /** 0..1 decay score (higher = more relevant). */
  decay: number;
  version: number;
}

/** Convenience type for creating a unit (id/version/timestamps omitted). */
export type NewUnit = Omit<Unit, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'sourceCount'> &
  Partial<Pick<Unit, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'sourceCount'>>;

export interface Source {
  id: SourceId;
  uri?: string;
  title: string;
  kind: SourceKind;
  contentHash: string;
  contentLength: number;
  createdAt: IsoDate;
}

/** Citation: a unit is backed by a (quote)span within a source. */
export interface UnitSource {
  unitId: UnitId;
  sourceId: SourceId;
  span?: string;
  assertedAt: IsoDate;
}

export interface Link {
  id: LinkId;
  sourceUnitId: UnitId;
  targetUnitId: UnitId;
  relation: LinkRelation;
  reason: string;
  confidence: number;
  auto: boolean;
  createdAt: IsoDate;
}

export interface Trace {
  id: TraceId;
  sessionId?: SessionId;
  title: string;
  content: string;
  contentType: string;
  tokenCount: number;
  createdAt: IsoDate;
}

/**
 * L2 — a project/scenario-level knowledge block: an LLM-consolidated
 * narrative that compresses many L1 units into one compact, loadable
 * working context. Keeps raw detail recoverable via `sourceUnitIds`.
 */
export interface Scenario {
  id: ScenarioId;
  title: string;
  /** one-line description. */
  summary: string;
  /** markdown narrative body (compressed knowledge block). */
  content: string;
  tags: string[];
  /** L1 units folded into this scenario (provenance, drill-down). */
  sourceUnitIds: UnitId[];
  status: ScenarioStatus;
  version: number;
  /** cumulative recall hits (Tencent scene heat): hotter scenes rank first. */
  heat: number;
  /** ISO date of the last recall hit. */
  lastHitAt?: IsoDate;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  lastConsolidatedAt?: IsoDate;
}

/**
 * L3 — the long-term persona/core profile of the workspace owner:
 * stable preferences, identity, working style. One per workspace.
 * Kept deliberately short (<~2000 chars) for cheap context bootstrap.
 */
export interface Persona {
  id: string;
  content: string;
  version: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/**
 * Portable memory asset, decoupled from any agent framework: a Skill
 * (reusable procedure with trigger + steps + validation), a Wiki page
 * (structured doc with link graph), a CodeGraph index (module/symbol map),
 * or a reusable prompt. Manageable, reviewable, routable.
 */
export interface Asset {
  id: AssetId;
  kind: AssetKind;
  name: string;
  description: string;
  /** structured payload (JSON string for skills/codegraph). */
  content: string;
  /** markdown body (steps for skills, page text for wiki). */
  body: string;
  /** when to use this asset (skill trigger / routing hint). */
  trigger: string;
  tags: string[];
  /** provenance: units this asset was distilled from. */
  sourceUnitIds: UnitId[];
  status: AssetStatus;
  /** routing scope; default 'workspace'. */
  visibility: AssetVisibility;
  /** agent/team keys allowed to use this asset when visibility is restrictive. */
  boundAgents: string[];
  version: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/**
 * Immutable snapshot of an asset at a point in time (version chain).
 * Written before a content-bearing update so any version of a Skill / Wiki /
 * CodeGraph / prompt can be recovered or diffed later.
 */
export interface AssetVersion {
  id: string;
  assetId: AssetId;
  /** version number of the snapshot (the version that was replaced). */
  version: number;
  snapshot: Omit<Asset, 'id'>;
  reason: string;
  createdAt: IsoDate;
}

export type NewAsset = Omit<Asset, 'id' | 'version' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<Asset, 'id' | 'version' | 'createdAt' | 'updatedAt'>>;

export interface Session {
  id: SessionId;
  label: string;
  agent?: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** Immutable snapshot of a unit at a point in time (bi-temporal history). */
export interface Version {
  id: VersionId;
  unitId: UnitId;
  version: number;
  snapshot: Omit<Unit, 'embedding'>;
  reason: string;
  createdAt: IsoDate;
}

export interface Job {
  id: JobId;
  kind: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  meta?: Record<string, unknown>;
  error?: string;
  createdAt: IsoDate;
  finishedAt?: IsoDate;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export interface AmemConfig {
  dbPath: string;
  host: string;
  port: number;
  apiToken?: string;
  corsOrigin?: string;
  /** When true, API/MCP require PAT/legacy bearer (except health + bootstrap). */
  authEnabled?: boolean;
  /** Trust X-Forwarded-For for client IP (rate limits). Only set behind a proxy. */
  trustProxy?: boolean;
  /** Append `Secure` to session cookies (HTTPS deployments behind a proxy). */
  cookieSecure?: boolean;
  /** HMAC secret for PAT hashing (>=16 chars recommended). */
  authSecret?: string;
  /** Allow legacy AMEM_API_TOKEN as full-access principal. */
  allowLegacyApiToken?: boolean;
  /** Bootstrap admin on first boot when auth enabled and no users exist. */
  bootstrapAdminEmail?: string;
  bootstrapAdminPassword?: string;
  /** Default PAT lifetime in days (0 = no expiry). */
  patDefaultTtlDays?: number;
  /** Per-IP sliding-window limits for auth/token endpoints (anti brute-force). */
  rateLimit?: {
    /** Master switch; false disables all auth endpoint throttling. */
    enabled?: boolean;
    /** Max POST /api/v1/auth/login attempts per minute per IP. */
    loginPerMinute?: number;
    /** Max POST /api/v1/auth/bootstrap attempts per hour per IP. */
    bootstrapPerHour?: number;
    /** Max /oauth/authorize + /oauth/token + /oauth/consent hits per minute per IP. */
    oauthPerMinute?: number;
    /** Max POST /oauth/register attempts per hour per IP. */
    registerPerHour?: number;
  };
  embedding: {
    mode: EmbeddingMode;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    /** offline embedder dimensionality. */
    dims?: number;
  };
  llm: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  thresholds: {
    /** independent sources required to promote a unit to a crystal. */
    minSourcesForCrystal: number;
    /** cosine similarity above which a candidate is treated as a duplicate. */
    dedupSimThreshold: number;
    /** cosine similarity above which a link is proposed. */
    linkSimThreshold: number;
    /** number of shared tags required before an offline tag-overlap link is proposed. */
    minSharedTags: number;
    /** max auto-links kept per unit (bounded graph degree, keeps the graph readable). */
    maxLinksPerUnit: number;
    contradictionThreshold: number;
    decayPerDay: number;
    /** below this decay, units are archived by the forgetting pass. */
    forgetThreshold: number;
    /** max tokens for a working-memory briefing. */
    workingMemoryBudget: number;
    /** default token budget for recall context assembly. */
    recallBudget: number;
    /** demotion applied to auto-extracted code-symbol units when the query is natural language. */
    codeSymbolPenalty: number;
    /** boost applied to procedure/decision/lesson units when the query is natural language. */
    knowledgeBoost: number;
    /** hard cap on active L2 scenes; beyond it new scenes merge into similar ones. */
    maxScenarios: number;
  };
  jobs: {
    enabled: boolean;
    debounceMs: number;
    intervalMs: number;
    maxPerHour: number;
    tokenBudgetDaily: number;
  };
  /** Auto-run asset precipitation after each ingest (scenarios/skills/codegraph/wiki). */
  autoPrecipitate?: {
    /** enable auto-precipitation after ingest; default false */
    enabled?: boolean;
    /** fast = heuristic-only (no LLM), auto/full may call LLM; default fast */
    mode?: 'fast' | 'auto' | 'full';
    /** minimum ms between auto runs; default 60_000 */
    minIntervalMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Operation inputs / results (service contract)
// ---------------------------------------------------------------------------
export interface IngestInput {
  sessionId?: SessionId;
  title: string;
  content: string;
  contentType?: string;
  sourceUri?: string;
  sourceKind?: SourceKind;
  /** run distillation to extract units. Default true. */
  extract?: boolean;
  /** run auto-linking after ingest. Default true. */
  autoLink?: boolean;
  /** automatically mark extracted units as reviewed. Default false. */
  autoReview?: boolean;
}

export interface IngestResult {
  trace: Trace;
  units: Unit[];
  deduplicated: Array<{ candidateTitle: string; matchedUnitId: UnitId }>;
  tokensSavedByDedup: number;
  /** scene segmentation report from the same transcript (best-effort). */
  scenes?: SceneExtractReport;
}

/** One conversation message accepted by `compact` (OpenAI/Anthropic-ish shape). */
export interface CompactMessage {
  role: string;
  content: string;
}

/** Context offload: compress a long transcript into distilled units + a compact replacement block. */
export interface CompactInput {
  /** Structured conversation messages (role + text content). */
  messages?: CompactMessage[];
  /** Raw transcript fallback (used when `messages` is absent). */
  content?: string;
  sessionId?: SessionId;
  /** Run auto-linking after distillation. Default false (fast path). */
  autoLink?: boolean;
  /** Rough target size of the returned replacement block in tokens. Default 300. */
  budget?: number;
}

export interface CompactResult {
  trace: Trace;
  units: Unit[];
  /** Compact context block that can replace the raw transcript in an agent prompt. */
  replacement: string;
  inputTokens: number;
  outputTokens: number;
  tokensSaved: number;
  deduplicated: Array<{ candidateTitle: string; matchedUnitId: UnitId }>;
}

/** Outcome of extracting conversation scenes into L2 scenarios. */
export interface SceneExtractReport {
  /** number of topic segments identified in the transcript. */
  segments: number;
  scenesCreated: number;
  scenesUpdated: number;
  scenesMerged: number;
  /** titles of scenes touched by this run. */
  touchedTitles: string[];
}

export interface RecallInput {
  query: string;
  /** token budget for the assembled context block. */
  tokenBudget?: number;
  /** max units to consider before budget truncation. */
  topK?: number;
  includeBody?: boolean;
}

export interface ContextItem {
  unit: UnitSummary;
  score: number;
  reason: string;
  citations: Source[];
}

export interface RecallResult {
  query: string;
  budget: number;
  usedTokens: number;
  items: ContextItem[];
  /** assembled, cited, token-budgeted context block for prompt injection. */
  text: string;
  grounded: boolean;
  /** units suppressed because they were near-duplicates of a higher-ranked one. */
  deduplicated?: number;
}

/** Layered recall: L3 persona bootstrap + L2 scenarios, then L1 units. */
export interface LayeredRecallResult {
  query: string;
  budget: number;
  usedTokens: number;
  persona?: { version: number; text: string };
  scenarios: Array<{ scenario: Scenario; score: number; reason: string }>;
  units: ContextItem[];
  /** assembled, layered, token-budgeted context block. */
  text: string;
  grounded: boolean;
  /** units suppressed because they were near-duplicates of a higher-ranked one. */
  deduplicated?: number;
}

export interface SearchResult {
  query: string;
  items: Array<{ unit: UnitSummary; score: number; via: 'semantic' | 'keyword' | 'hybrid' }>;
}

export interface UnitSummary {
  id: UnitId;
  type: UnitType;
  form: MemoryForm;
  title: string;
  summary: string;
  tags: string[];
  /** Auto/manual classification stored on labels.category. */
  category?: string;
  importance: number;
  decay: number;
  status: UnitStatus;
  updatedAt: IsoDate;
}

export interface UnitNode extends UnitSummary {
  quality: number;
  confidence: number;
  degree: number;
  /** Community cluster id, present when graph clusters are requested. */
  community?: string;
  /** Human label of the community cluster, present when requested. */
  communityLabel?: string;
  /** Node is an L2 scenario block (hot-scene navigation) rather than a unit. */
  isScenario?: boolean;
  /** Scenario heat (recall hits) — "hot scenes first" navigation. */
  heat?: number;
}

export interface Graph {
  nodes: UnitNode[];
  links: Array<Pick<Link, 'id' | 'sourceUnitId' | 'targetUnitId' | 'relation' | 'confidence' | 'auto'>>;
  clusters?: NodeCluster[];
}

export interface WorkingMemory {
  date: IsoDate;
  text: string;
  tokenCount: number;
  selected: UnitSummary[];
}

export interface LayerRefreshResult {
  scenariosCreated: number;
  scenariosUpdated: number;
  personaUpdated: boolean;
  skillsExtracted: number;
  skillsCreated: number;
  skillsUpdated: number;
  unitsCovered: number;
}

export interface SkillExtractResult {
  created: number;
  updated: number;
  assets: Asset[];
}

/** Result of a heuristic (zero-LLM) asset extraction (codegraph/wiki). */
export interface AssetExtractResult {
  created: number;
  updated: number;
  assets: Asset[];
}

/** Result of an on-demand asset call (Tencent-style tools/call). */
export interface AssetCallResult {
  assetId: AssetId;
  kind: AssetKind;
  name: string;
  trigger: string;
  body: string;
  version: number;
  usedTokens: number;
  budget: number;
  truncated: boolean;
}

/** One scored candidate from task-to-asset routing (Tencent-style skill routing). */
export interface AssetRouteItem {
  asset: Asset;
  score: number;
  reason: string;
}

/** Ranked assets for a task description: the "route" half of manage/review/route. */
export interface AssetRouteResult {
  query: string;
  items: AssetRouteItem[];
  usedTokens: number;
}

export interface RouteAssetsInput {
  /** Natural-language task description to route. */
  task: string;
  /** When set, restrict to assets the agent is allowed to use (callAsset rule). */
  agent?: string;
  kind?: AssetKind;
  limit?: number;
}

/** Full auto-precipitation pipeline: L2/L3 layers + skills + codegraph + wiki. */
export interface PrecipitateResult {
  mode: 'fast' | 'auto' | 'full';
  scenariosCreated: number;
  scenariosUpdated: number;
  personaUpdated: boolean;
  skillsExtracted: number;
  codegraphCreated: number;
  codegraphUpdated: number;
  wikiCreated: number;
  wikiUpdated: number;
}

// ---------------------------------------------------------------------------
// Cold-start importers (docs / codebase / agent sessions)
// ---------------------------------------------------------------------------
export interface ImportDirInput {
  /** absolute path to a directory of documents (md/txt/…). */
  path: string;
  /** file extension filter, e.g. ['.md', '.txt']; default md+txt. */
  extensions?: string[];
  /** run LLM/heuristic distillation per file. Default true. */
  extract?: boolean;
  sourceKind?: SourceKind;
}

export interface ImportCodebaseInput {
  /** absolute path to a codebase root. */
  path: string;
  /** extension allowlist; default common code extensions. */
  extensions?: string[];
  /** max files indexed. Default 500. */
  maxFiles?: number;
  /** max file bytes read into memory. Default 512 KB. */
  maxBytesPerFile?: number;
}

export interface ImportSessionsInput {
  /** path to a session file or a directory of session files. */
  path: string;
  /** auto-detect from extension: .jsonl / .json / .txt. */
  format?: 'auto' | 'jsonl' | 'json' | 'txt';
  /** session label override (defaults to file basename). */
  sessionLabel?: string;
  /** run distillation per session. Default true. */
  extract?: boolean;
}

export interface ImportSourcesResult {
  units: number;
  traces: number;
  links: number;
  sources: number;
  files: number;
  sessions: number;
  tokensSavedByDedup: number;
}

/** Cold-start bootstrap: import sessions/docs/codebase, then optionally precipitate assets + persona. */
export interface SeedInput {
  /** Directory or file of agent conversation sessions (JSONL/JSON/TXT). */
  sessionsPath?: string;
  /** Directory of documents to index (md/txt/...). */
  docsPath?: string;
  /** Codebase directory to build a light CodeGraph from. */
  codebasePath?: string;
  sessionLabel?: string;
  /** Auto-precipitate assets (skills/wiki/codegraph) after import. Default true. */
  precipitate?: boolean;
  /** Refresh the L3 persona from imported units. Default true. */
  persona?: boolean;
}

export interface SeedResult {
  imported: ImportSourcesResult | null;
  docs: ImportSourcesResult | null;
  codebase: ImportSourcesResult | null;
  totalUnits: number;
  precipitated: PrecipitateResult | null;
  persona: Persona | null;
}

export interface CurateReport {
  jobs: JobId[];
  linksCreated: number;
  /** auto tag-overlap links removed because they no longer meet the threshold. */
  linksPruned: number;
  crystalsPromoted: number;
  contradictionsFlagged: number;
  archived: number;
  summary: string;
}

export interface ImportResult {
  units: number;
  traces: number;
  links: number;
  sources: number;
}

export interface ExportBundle {
  version: 1;
  exportedAt: IsoDate;
  graph: Graph;
  units: Unit[];
  links: Link[];
  traces: Trace[];
  sources: Source[];
  unitSources: UnitSource[];
  /** L2 scenarios (portability across agents/frameworks). */
  scenarios?: Scenario[];
  /** L3 persona (one per workspace). */
  persona?: Persona | null;
  /** portable assets (skills/wiki/codegraph/prompts). */
  assets?: Asset[];
}

export interface StatsCounts {
  units: number;
  unitsActive: number;
  crystals: number;
  traces: number;
  links: number;
  sources: number;
  sessions: number;
  pendingReview: number;
}

export interface Stats {
  counts: StatsCounts;
  byType: Partial<Record<UnitType, number>>;
  /** input tokens avoided by de-duplicating known knowledge. */
  tokensSavedByDedup: number;
  /** context tokens delivered by recall (vs raw history). */
  recallTokensDelivered: number;
  tokenWasteAvoided: number;
  perDay: Array<{ day: string; units: number; traces: number }>;
  graph: { nodeCount: number; linkCount: number; communityCount: number };
}

/** Kinds of audit/activity events surfaced in the Web UI. */
export type ActivityKind =
  | 'ingest'
  | 'save_unit'
  | 'update_unit'
  | 'recall'
  | 'search'
  | 'curate'
  | 'review'
  | 'forget'
  | 'link'
  | 'import'
  | 'export'
  | 'auth_login'
  | 'auth_bootstrap'
  | 'auth_token_create'
  | 'auth_token_revoke'
  | 'workspace_create'
  | 'workspace_member_add'
  | 'workspace_member_remove'
  | 'scenario'
  | 'persona'
  | 'asset'
  | 'refresh_layers'
  | 'extract_skills'
  | 'extract_codegraph'
  | 'extract_wiki'
  | 'precipitate'
  | 'import_dir'
  | 'import_codebase'
  | 'import_sessions';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind | string;
  summary: string;
  actor?: string;
  meta?: Record<string, unknown>;
  createdAt: IsoDate;
}

export interface ActivityFilter {
  kind?: string;
  limit?: number;
  before?: IsoDate;
}

// ---------------------------------------------------------------------------
// Service + LLM contracts
// ---------------------------------------------------------------------------
export interface AmemService {
  ingest(input: IngestInput): Promise<IngestResult>;
  /** Context offload: compress a conversation into distilled units + a compact replacement block. */
  compact(input: CompactInput): Promise<CompactResult>;
  recall(input: RecallInput): Promise<RecallResult>;
  recallLayered(input: RecallInput): Promise<LayeredRecallResult>;
  search(query: string, opts?: { limit?: number; includeBody?: boolean }): Promise<SearchResult>;
  saveUnit(unit: NewUnit): Promise<Unit>;
  getUnit(id: UnitId): Promise<Unit | null>;
  updateUnit(id: UnitId, patch: Partial<NewUnit>, reason?: string): Promise<Unit>;
  deleteUnit(id: UnitId, reason?: string): Promise<void>;
  reviewUnit(id: UnitId, action: 'accept' | 'discard'): Promise<Unit | null>;
  listUnits(filter?: { type?: UnitType; status?: UnitStatus; tag?: string; category?: string; limit?: number; offset?: number }): Promise<UnitSummary[]>;
  /** Batch classify units by the category taxonomy (rules + optional LLM). */
  classifyUnits(opts?: { ids?: string[]; mode?: 'rules' | 'llm' | 'auto'; reclassify?: boolean }): Promise<import('./classify.js').ClassifyReport>;
  /** Batch manage units: archive / restore / delete / accept. */
  batchUnits(opts: {
    ids: UnitId[];
    action: 'archive' | 'restore' | 'delete' | 'accept';
  }): Promise<{ affected: number; skipped: number }>;
  getGraph(includeClusters?: boolean, includeScenarios?: boolean): Promise<Graph>;
  linkUnits(input: { sourceUnitId: UnitId; targetUnitId: UnitId; relation: LinkRelation; reason?: string; auto?: boolean }): Promise<Link>;
  getLinksForUnit(unitId: UnitId): Promise<Link[]>;
  /** Trim auto-generated links so each unit keeps its strongest neighbors (bounded degree). */
  pruneAutoLinks(opts?: { maxPerUnit?: number; dryRun?: boolean }): Promise<{ examined: number; kept: number; deleted: number }>;
  workingMemory(date?: IsoDate, budget?: number): Promise<WorkingMemory>;
  // --- L2 scenarios / L3 persona ---
  listScenarios(filter?: { tag?: string; status?: ScenarioStatus; limit?: number; sort?: 'updated' | 'heat' }): Promise<Scenario[]>;
  getScenario(id: ScenarioId): Promise<Scenario | null>;
  refreshLayers(opts?: {
    tags?: string[];
    forcePersona?: boolean;
    maxScenarios?: number;
    mode?: 'fast' | 'auto' | 'full';
  }): Promise<LayerRefreshResult>;
  getPersona(): Promise<Persona | null>;
  // --- Assets (skill/wiki/codegraph/prompt) ---
  listAssets(filter?: { kind?: AssetKind; status?: AssetStatus; limit?: number }): Promise<Asset[]>;
  getAsset(id: AssetId): Promise<Asset | null>;
  listAssetVersions(id: AssetId): Promise<AssetVersion[]>;
  saveAsset(asset: NewAsset): Promise<Asset>;
  updateAsset(id: AssetId, patch: Partial<NewAsset>, reason?: string): Promise<Asset>;
  deleteAsset(id: AssetId): Promise<void>;
  listEquipped(agent: string): Promise<Asset[]>;
  /** Rank published assets for a task description (unified manage/review/route). */
  routeAssets(input: RouteAssetsInput): Promise<AssetRouteResult>;
  callAsset(input: {
    id: AssetId;
    agent?: string;
    query?: string;
    budget?: number;
  }): Promise<AssetCallResult>;
  extractSkills(opts?: { limit?: number; includePending?: boolean }): Promise<SkillExtractResult>;
  extractCodegraph(opts?: { limit?: number }): Promise<AssetExtractResult>;
  extractWiki(opts?: { limit?: number }): Promise<AssetExtractResult>;
  autoPrecipitate(opts?: { mode?: 'fast' | 'auto' | 'full' }): Promise<PrecipitateResult>;
  // --- Cold-start importers ---
  importDirectory(input: ImportDirInput): Promise<ImportSourcesResult>;
  importCodebase(input: ImportCodebaseInput): Promise<ImportSourcesResult>;
  importSessions(input: ImportSessionsInput): Promise<ImportSourcesResult>;
  /** Cold-start bootstrap: import sessions/docs/codebase, then precipitate assets + persona. */
  seed(input: SeedInput): Promise<SeedResult>;
  forget(unitId: UnitId, reason: string): Promise<void>;
  curate(preset?: 'fast' | 'full'): Promise<CurateReport>;
  stats(): Promise<Stats>;
  activity(filter?: ActivityFilter): Promise<ActivityEvent[]>;
  getTraces(filter?: { sessionId?: SessionId; limit?: number }): Promise<Trace[]>;
  getTrace(id: TraceId): Promise<Trace | null>;
  import(payload: ExportBundle): Promise<ImportResult>;
  export(): Promise<ExportBundle>;
  health(): { ok: boolean; version: string; embeddingMode: EmbeddingMode };
  /** Swap the LLM client at runtime (Settings provider activate/update). */
  setLlm(llm: import('./llm.js').LlmClient): void;
  /** Swap the embedder at runtime (Settings provider activate/update). */
  setEmbedder(embedder: import('./embedder.js').Embedder): void;
}
