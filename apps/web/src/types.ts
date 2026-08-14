export type UnitType =
  | 'fact' | 'decision' | 'plan' | 'procedure' | 'preference' | 'concept' | 'lesson' | 'question';
export type UnitStatus = 'pending' | 'reviewed' | 'archived' | 'merged' | 'flagged';
export type MemoryForm = 'trace' | 'unit' | 'crystal';
export type LinkRelation =
  | 'supports' | 'contradicts' | 'part_of' | 'extends' | 'precedes'
  | 'references' | 'related_to' | 'supersedes' | 'caused_by';

export interface Source { id: string; uri?: string; title: string; kind: string; contentLength: number; createdAt: string; }
export interface Unit {
  id: string; type: UnitType; form: MemoryForm; title: string; summary: string; body: string;
  tags: string[]; labels: Record<string, string | number | boolean>; status: UnitStatus; quality: number; confidence: number;
  createdAt: string; updatedAt: string; sourceCount: number; importance: number; decay: number; version: number;
  zoneId?: string; workspaceId?: string; createdByUserId?: string; agent?: string;
}
export interface UnitSummary {
  id: string; type: UnitType; form: MemoryForm; title: string; summary: string; tags: string[];
  category?: string;
  zoneId?: string;
  workspaceId?: string;
  createdByUserId?: string;
  agent?: string;
  importance: number; decay: number; status: UnitStatus; updatedAt: string;
}

export interface LibraryTreeNode {
  zoneId: string;
  slug: string;
  name: string;
  kind: string;
  visibility: string;
  unitCount: number;
  agents: Array<{ agent: string; count: number }>;
  sources: Array<{ title: string; kind: string; count: number }>;
}
export interface UnitNode extends UnitSummary {
  quality: number;
  confidence: number;
  degree: number;
  community?: string;
  communityLabel?: string;
  isScenario?: boolean;
  heat?: number;
}
export interface Link { id: string; sourceUnitId: string; targetUnitId: string; relation: LinkRelation; reason: string; confidence: number; auto: boolean; createdAt: string; }
export interface GraphLink { id: string; sourceUnitId: string; targetUnitId: string; relation: LinkRelation; confidence: number; auto: boolean; }
export interface Graph { nodes: UnitNode[]; links: GraphLink[]; clusters?: Array<{ id: string; label: string; unitIds: string[] }>; }
export interface Trace { id: string; sessionId?: string; title: string; content: string; contentType: string; tokenCount: number; createdAt: string; }
export interface ContextItem { unit: UnitSummary; score: number; reason: string; citations: Source[]; }
export interface RecallResult { query: string; budget: number; usedTokens: number; items: ContextItem[]; text: string; grounded: boolean; }
export interface SearchResult {
  query: string;
  items: Array<{ unit: UnitSummary; score: number; via: string; terms: string[] }>;
  total: number;
}
export interface WorkingMemory { date: string; text: string; tokenCount: number; selected: UnitSummary[]; }
export interface StatsCounts {
  units: number; unitsActive: number; crystals: number; traces: number; links: number;
  sources: number; sessions: number; pendingReview: number; scenarios: number; assets: number;
}
export interface Stats {
  counts: StatsCounts; byType: Partial<Record<UnitType, number>>;
  byCategory: Record<string, number>;
  tokensSavedByDedup: number; recallTokensDelivered: number; tokenWasteAvoided: number;
  perDay: Array<{ day: string; units: number; traces: number }>;
  graph: { nodeCount: number; linkCount: number; communityCount: number };
}
export interface IngestResult { trace: Trace; units: Unit[]; deduplicated: Array<{ candidateTitle: string; matchedUnitId: string }>; tokensSavedByDedup: number; }
export interface Version { id: string; unitId: string; version: number; reason: string; createdAt: string; }

export type ScenarioStatus = 'active' | 'stale' | 'archived';
export type AssetKind = 'skill' | 'wiki' | 'codegraph' | 'prompt';
export type AssetStatus = 'draft' | 'reviewed' | 'published' | 'archived';
export type AssetVisibility = 'private' | 'workspace' | 'team' | 'public';

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  sourceUnitIds: string[];
  status: ScenarioStatus;
  version: number;
  heat?: number;
  lastHitAt?: string;
  createdAt: string;
  updatedAt: string;
  lastConsolidatedAt?: string;
}

export interface Persona {
  id: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  kind: AssetKind;
  name: string;
  description: string;
  content: string;
  body: string;
  trigger: string;
  tags: string[];
  sourceUnitIds: string[];
  status: AssetStatus;
  visibility: AssetVisibility;
  boundAgents: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetCallResult {
  assetId: string;
  kind: AssetKind;
  name: string;
  trigger: string;
  body: string;
  version: number;
  usedTokens: number;
  budget: number;
  truncated: boolean;
}

export interface LayeredRecallResult {
  query: string;
  budget: number;
  usedTokens: number;
  persona?: { version: number; text: string };
  scenarios: Array<{ scenario: Scenario; score: number; reason: string }>;
  units: ContextItem[];
  text: string;
  grounded: boolean;
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

export interface AssetExtractResult {
  created: number;
  updated: number;
  assets: Asset[];
}

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

export interface ImportSourcesResult {
  units: number;
  traces: number;
  links: number;
  sources: number;
  files: number;
  sessions: number;
  tokensSavedByDedup: number;
  ocrPages?: number;
}

export interface AiProvider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  model: string;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** API responses never include the raw key. */
  hasKey: boolean;
  keyPrefix?: string;
  hasEmbeddingKey?: boolean;
}

export interface AiStatus {
  active: AiProvider | null;
  env: { baseUrl: string; model: string; hasKey: boolean } | null;
  mode: 'provider' | 'env' | 'mock';
  embedding: { mode: 'api' | 'offline'; model?: string };
  ocr: { baseUrl: string; model: string; minChars?: number } | null;
}

export interface OcrSettings {
  baseUrl: string;
  model: string;
  minChars: number;
  updatedAt: string;
  hasKey: boolean;
  keyPrefix?: string;
}

export type ActivityKind =
  | 'ingest' | 'save_unit' | 'update_unit' | 'recall' | 'search'
  | 'curate' | 'review' | 'forget' | 'link' | 'import' | 'export'
  | 'scenario' | 'persona' | 'asset' | 'refresh_layers' | 'extract_skills'
  | 'import_dir' | 'import_codebase' | 'import_sessions';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind | string;
  summary: string;
  actor?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export type PipelineStageKind = 'ingested' | 'stored' | 'distilled' | 'curated' | 'recalled';

export interface PipelineStage {
  id: string;
  cardId: string;
  cardTitle: string;
  kind: PipelineStageKind | string;
  actor?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface ActivitySummary {
  window: { events: number; hours: number; since: string };
  input: { total: number; byKind: Record<string, number>; unitsCreated: number };
  output: { total: number; byKind: Record<string, number>; tokensDelivered: number; budgetUsed: number; tokenSavings: number };
  accessedUnits: Array<{
    unitId: string;
    title: string;
    type: string;
    category: string;
    tags: string[];
    accessCount: number;
    lastAccessedAt: string;
    actors: string[];
  }>;
  regions: {
    byType: Array<{ key: string; count: number }>;
    byCategory: Array<{ key: string; count: number }>;
    byTag: Array<{ key: string; count: number }>;
  };
  topActors: Array<{ actor: string; writes: number; reads: number }>;
}

export type ZoneKind = 'personal' | 'shared' | 'project' | 'inbox';
export type ZoneVisibility = 'private' | 'workspace' | 'members';
export type ZoneMemberRole = 'owner' | 'editor' | 'reader';

export interface Zone {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  kind: ZoneKind;
  ownerUserId?: string;
  visibility: ZoneVisibility;
  description?: string;
  auto: boolean;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  unitCount: number;
}

export interface ZoneMember {
  zoneId: string;
  userId: string;
  role: ZoneMemberRole;
  createdAt: string;
}
