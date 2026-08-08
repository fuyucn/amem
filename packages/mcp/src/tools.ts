import type {
  AmemService,
  ExportBundle,
  LinkRelation,
  NewAsset,
  NewUnit,
  UnitStatus,
  UnitType,
} from '@amem/core';
import { AmemError } from '@amem/core';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const TOOL_NAMES = [
  'ingest',
  'compact',
  'recall',
  'recall_layered',
  'search',
  'save_unit',
  'get_unit',
  'update_unit',
  'list_units',
  'link_units',
  'prune_links',
  'get_graph',
  'working_memory',
  'list_scenarios',
  'get_scenario',
  'refresh_layers',
  'get_persona',
  'list_assets',
  'list_equipped',
  'route_skills',
  'get_asset',
  'list_asset_versions',
  'call_asset',
  'save_asset',
  'extract_skills',
  'extract_codegraph',
  'extract_wiki',
  'precipitate',
  'import_directory',
  'import_codebase',
  'import_sessions',
  'seed',
  'review_unit',
  'forget',
  'classify_units',
  'batch_units',
  'curate',
  'stats',
  'activity',
  'export',
  'import',
  'health',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const STATUSES = ['pending', 'reviewed', 'archived', 'merged', 'flagged'] as const;
const UNIT_TYPES = [
  'fact',
  'decision',
  'plan',
  'procedure',
  'preference',
  'concept',
  'lesson',
  'question',
] as const;
const RELATIONS = [
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

export const toolSchemas = {
  ingest: z.object({
    title: z.string(),
    content: z.string(),
    contentType: z.string().optional(),
    sourceUri: z.string().optional(),
    sessionId: z.string().optional(),
    extract: z.boolean().optional(),
    autoLink: z.boolean().optional(),
    autoReview: z.boolean().optional(),
  }),
  compact: z.object({
    messages: z
      .array(z.object({ role: z.string(), content: z.string() }))
      .optional(),
    content: z.string().optional(),
    sessionId: z.string().optional(),
    autoLink: z.boolean().optional(),
    budget: z.number().int().positive().optional(),
  }),
  recall: z.object({
    query: z.string(),
    tokenBudget: z.number().optional(),
    topK: z.number().optional(),
    includeBody: z.boolean().optional(),
  }),
  recall_layered: z.object({
    query: z.string(),
    tokenBudget: z.number().optional(),
    topK: z.number().optional(),
    includeBody: z.boolean().optional(),
  }),
  search: z.object({
    query: z.string(),
    limit: z.number().optional(),
  }),
  save_unit: z.object({
    unit: z.record(z.string(), z.unknown()),
  }),
  get_unit: z.object({ id: z.string() }),
  update_unit: z.object({
    id: z.string(),
    patch: z.record(z.string(), z.unknown()),
    reason: z.string().optional(),
  }),
  list_units: z.object({
    type: z.enum(UNIT_TYPES).optional(),
    status: z.enum(STATUSES).optional(),
    tag: z.string().optional(),
    limit: z.number().optional(),
  }),
  link_units: z.object({
    sourceUnitId: z.string(),
    targetUnitId: z.string(),
    relation: z.enum(RELATIONS),
    reason: z.string().optional(),
  }),
  prune_links: z.object({
    maxPerUnit: z.number().int().positive().optional(),
    dryRun: z.boolean().optional(),
  }),
  get_graph: z.object({ includeClusters: z.boolean().optional() }),
  working_memory: z.object({
    date: z.string().optional(),
    budget: z.number().optional(),
  }),
  list_scenarios: z.object({
    tag: z.string().optional(),
    status: z.enum(['active', 'stale', 'archived']).optional(),
    limit: z.number().optional(),
  }),
  get_scenario: z.object({ id: z.string() }),
  refresh_layers: z.object({
    tags: z.array(z.string()).optional(),
    forcePersona: z.boolean().optional(),
    maxScenarios: z.number().optional(),
    mode: z.enum(['fast', 'auto', 'full']).optional(),
  }),
  get_persona: z.object({}),
  list_assets: z.object({
    kind: z.enum(['skill', 'wiki', 'codegraph', 'prompt']).optional(),
    status: z.enum(['draft', 'reviewed', 'published', 'archived']).optional(),
    limit: z.number().optional(),
  }),
  list_equipped: z.object({
    agent: z.string(),
  }),
  route_skills: z.object({
    task: z.string(),
    agent: z.string().optional(),
    kind: z.enum(['skill', 'wiki', 'codegraph', 'prompt']).optional(),
    limit: z.number().optional(),
  }),
  get_asset: z.object({ id: z.string() }),
  list_asset_versions: z.object({ id: z.string() }),
  call_asset: z.object({
    id: z.string(),
    agent: z.string().optional(),
    query: z.string().optional(),
    budget: z.number().optional(),
  }),
  save_asset: z.object({
    asset: z.record(z.string(), z.unknown()),
  }),
  extract_skills: z.object({
    limit: z.number().optional(),
    includePending: z.boolean().optional(),
  }),
  extract_codegraph: z.object({
    limit: z.number().optional(),
  }),
  extract_wiki: z.object({
    limit: z.number().optional(),
  }),
  precipitate: z.object({
    mode: z.enum(['fast', 'auto', 'full']).optional(),
  }),
  import_directory: z.object({
    path: z.string(),
    extensions: z.array(z.string()).optional(),
    extract: z.boolean().optional(),
  }),
  import_codebase: z.object({
    path: z.string(),
    extensions: z.array(z.string()).optional(),
    maxFiles: z.number().optional(),
  }),
  import_sessions: z.object({
    path: z.string(),
    format: z.enum(['auto', 'jsonl', 'json', 'txt']).optional(),
    sessionLabel: z.string().optional(),
    extract: z.boolean().optional(),
  }),
  seed: z.object({
    sessionsPath: z.string().optional(),
    docsPath: z.string().optional(),
    codebasePath: z.string().optional(),
    sessionLabel: z.string().optional(),
    precipitate: z.boolean().optional(),
    persona: z.boolean().optional(),
  }),
  review_unit: z.object({
    id: z.string(),
    action: z.enum(['accept', 'discard']),
  }),
  forget: z.object({ id: z.string(), reason: z.string() }),
  classify_units: z.object({
    ids: z.array(z.string()).optional(),
    mode: z.enum(['rules', 'llm', 'auto']).optional(),
    reclassify: z.boolean().optional(),
  }),
  batch_units: z.object({
    ids: z.array(z.string()),
    action: z.enum(['archive', 'restore', 'delete', 'accept']),
  }),
  curate: z.object({ preset: z.enum(['fast', 'full']).optional() }),
  stats: z.object({}),
  activity: z.object({
    kind: z.string().optional(),
    limit: z.number().optional(),
  }),
  export: z.object({}),
  import: z.object({ bundle: z.record(z.string(), z.unknown()) }),
  health: z.object({}),
} satisfies Record<ToolName, z.ZodType>;

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const DESCRIPTIONS: Record<ToolName, string> = {
  ingest:
    'Save a trace and distill atomic knowledge units into memory (with deduplication).',
  compact:
    'Context offload: compress a long conversation (messages or content) into distilled units and return a compact replacement block that can stand in for the raw transcript in an agent prompt.',
  recall:
    'Assemble a compact, cited context block from memory for prompt injection.',
  recall_layered:
    'Layered recall (L3 persona + L2 scenario blocks + L1 precise units) with token budgeting. Prefer for long-running sessions and project bootstrapping.',
  search: 'Hybrid keyword + semantic search over the knowledge graph.',
  save_unit: 'Manually write a knowledge unit (procedures, plans, facts).',
  get_unit: 'Read a single knowledge unit by id.',
  update_unit: 'Edit a unit, recording a bi-temporal version.',
  list_units: 'Browse units, optionally filtered by type, status, or tag.',
  link_units: 'Manually cross-reference two units.',
  prune_links:
    'Trim auto-generated links so each unit keeps its strongest neighbors (bounded graph degree). Use dryRun to preview.',
  get_graph: 'Fetch graph nodes and edges for graph-aware reasoning.',
  working_memory: "Today's compact working-memory briefing (attention prefetch).",
  list_scenarios:
    'List L2 scenario knowledge blocks (project/area consolidated narratives).',
  get_scenario: 'Read one L2 scenario by id, including sourceUnitIds for drill-down.',
  refresh_layers:
    'Run the L2/L3 pipeline: consolidate units into scenarios, refresh the persona, and extract Skill assets. Idempotent.',
  get_persona: 'Read the L3 long-term persona profile for this workspace.',
  list_assets: 'List portable assets (skill/wiki/codegraph/prompt).',
  list_equipped:
    'Discover published assets an agent is routed to (visibility public/workspace or explicit binding). Tencent-style tools/list.',
  route_skills:
    'Rank published assets (skills/wiki/codegraph/prompts) for a task description (Tencent-style skill routing).',
  get_asset: 'Read one asset by id.',
  list_asset_versions: 'Read the version chain (immutable snapshots) of an asset, newest first.',
  call_asset:
    'Call a published asset on demand and return its content within a token budget (Tencent-style tools/call). Records usage in Activity.',
  save_asset: 'Create or update a portable asset (e.g. a wiki page or prompt).',
  extract_skills:
    'Extract Skill assets from procedure/lesson/preference units. Idempotent by name.',
  extract_codegraph:
    'Aggregate imported code units into CodeGraph assets (idempotent, no LLM).',
  extract_wiki:
    'Aggregate doc-sourced units into Wiki page assets (idempotent, no LLM).',
  precipitate:
    'Run the full auto-precipitation pipeline: L2/L3 layers, skills, codegraph, and wiki assets.',
  import_directory:
    'Cold-start import: index a directory of documents into memory.',
  import_codebase:
    'Cold-start import: build a light CodeGraph from a codebase (modules + symbols).',
  import_sessions:
    'Cold-start import: parse agent transcripts (JSONL/JSON/TXT) into memory.',
  seed:
    'Cold-start bootstrap: import sessions + docs + codebase in one call, then optionally auto-precipitate assets (skills/wiki/codegraph) and refresh the L3 persona.',
  review_unit: 'Accept or discard an auto-extracted unit.',
  forget: 'Remove a unit from memory.',
  classify_units:
    'Classify units into the category taxonomy (code/infra/workflow/product/personal/research/meta/other). Rule-based offline; mode=llm refines with the configured provider when available.',
  batch_units:
    'Batch manage units: archive, restore, delete, or accept a set of unit ids.',
  curate: 'Run consolidation: link, promote crystals, and decay.',
  stats: 'Counts and token-savings metrics.',
  activity:
    'Recent memory activity: newly ingested/saved knowledge and recall/search usage. Use to confirm what was written and what was used.',
  export: 'Full JSON export of the knowledge base (data sovereignty).',
  import: 'Restore a previously exported bundle.',
  health: 'Liveness check: ok, version, and embedding mode.',
};

type Executor = (
  service: AmemService,
  args: Record<string, unknown>,
) => Promise<unknown>;

const optionalStr = (value: unknown): string | undefined =>
  value === undefined ? undefined : String(value);
const optionalNum = (value: unknown): number | undefined =>
  value === undefined ? undefined : Number(value);
const optionalBool = (value: unknown): boolean | undefined =>
  value === undefined ? undefined : Boolean(value);

const executors: Record<ToolName, Executor> = {
  async ingest(service, a) {
    return service.ingest({
      title: String(a.title),
      content: String(a.content),
      contentType: optionalStr(a.contentType),
      sourceUri: optionalStr(a.sourceUri),
      sessionId: optionalStr(a.sessionId),
      extract: optionalBool(a.extract),
      autoLink: optionalBool(a.autoLink),
      autoReview: optionalBool(a.autoReview),
    });
  },
  async compact(service, a) {
    return service.compact({
      messages: Array.isArray(a.messages)
        ? (a.messages as Array<{ role: string; content: string }>)
        : undefined,
      content: optionalStr(a.content),
      sessionId: optionalStr(a.sessionId),
      autoLink: optionalBool(a.autoLink),
      budget: optionalNum(a.budget),
    });
  },
  async recall(service, a) {
    return service.recall({
      query: String(a.query),
      tokenBudget: optionalNum(a.tokenBudget),
      topK: optionalNum(a.topK),
      includeBody: optionalBool(a.includeBody),
    });
  },
  async recall_layered(service, a) {
    return service.recallLayered({
      query: String(a.query),
      tokenBudget: optionalNum(a.tokenBudget),
      topK: optionalNum(a.topK),
      includeBody: optionalBool(a.includeBody),
    });
  },
  async search(service, a) {
    return service.search(String(a.query), {
      limit: optionalNum(a.limit),
    });
  },
  async save_unit(service, a) {
    return service.saveUnit(a.unit as NewUnit);
  },
  async get_unit(service, a) {
    const unit = await service.getUnit(String(a.id));
    if (!unit) {
      throw new ToolError('NOT_FOUND', `Unit not found: ${String(a.id)}`);
    }
    return unit;
  },
  async update_unit(service, a) {
    return service.updateUnit(
      String(a.id),
      a.patch as Partial<NewUnit>,
      optionalStr(a.reason),
    );
  },
  async list_units(service, a) {
    return service.listUnits({
      type: a.type === undefined ? undefined : (a.type as UnitType),
      status: a.status === undefined ? undefined : (a.status as UnitStatus),
      tag: optionalStr(a.tag),
      limit: optionalNum(a.limit),
    });
  },
  async link_units(service, a) {
    return service.linkUnits({
      sourceUnitId: String(a.sourceUnitId),
      targetUnitId: String(a.targetUnitId),
      relation: a.relation as LinkRelation,
      reason: optionalStr(a.reason),
    });
  },
  async prune_links(service, a) {
    return service.pruneAutoLinks({
      maxPerUnit: optionalNum(a.maxPerUnit),
      dryRun: optionalBool(a.dryRun),
    });
  },
  async get_graph(service, a) {
    return service.getGraph(optionalBool(a.includeClusters));
  },
  async working_memory(service, a) {
    return service.workingMemory(optionalStr(a.date), optionalNum(a.budget));
  },
  async list_scenarios(service, a) {
    return service.listScenarios({
      tag: optionalStr(a.tag),
      status: a.status === undefined ? undefined : (a.status as 'active' | 'stale' | 'archived'),
      limit: optionalNum(a.limit),
    });
  },
  async get_scenario(service, a) {
    const scenario = await service.getScenario(String(a.id));
    if (!scenario) throw new ToolError('NOT_FOUND', `Scenario not found: ${String(a.id)}`);
    return scenario;
  },
  async refresh_layers(service, a) {
    return service.refreshLayers({
      tags: Array.isArray(a.tags) ? a.tags.map(String) : undefined,
      forcePersona: optionalBool(a.forcePersona),
      maxScenarios: optionalNum(a.maxScenarios),
      mode: a.mode === undefined ? undefined : (a.mode as 'fast' | 'auto' | 'full'),
    });
  },
  async get_persona(service) {
    return service.getPersona();
  },
  async list_assets(service, a) {
    return service.listAssets({
      kind: a.kind === undefined ? undefined : (a.kind as 'skill' | 'wiki' | 'codegraph' | 'prompt'),
      status: a.status === undefined ? undefined : (a.status as 'draft' | 'reviewed' | 'published' | 'archived'),
      limit: optionalNum(a.limit),
    });
  },
  async list_equipped(service, a) {
    return service.listEquipped(String(a.agent));
  },
  async route_skills(service, a) {
    return service.routeAssets({
      task: String(a.task),
      agent: optionalStr(a.agent),
      kind: a.kind === undefined ? undefined : (a.kind as 'skill' | 'wiki' | 'codegraph' | 'prompt'),
      limit: optionalNum(a.limit),
    });
  },
  async get_asset(service, a) {
    const asset = await service.getAsset(String(a.id));
    if (!asset) throw new ToolError('NOT_FOUND', `Asset not found: ${String(a.id)}`);
    return asset;
  },
  async list_asset_versions(service, a) {
    const asset = await service.getAsset(String(a.id));
    if (!asset) throw new ToolError('NOT_FOUND', `Asset not found: ${String(a.id)}`);
    return service.listAssetVersions(String(a.id));
  },
  async call_asset(service, a) {
    return service.callAsset({
      id: String(a.id),
      agent: optionalStr(a.agent),
      query: optionalStr(a.query),
      budget: optionalNum(a.budget),
    });
  },
  async save_asset(service, a) {
    return service.saveAsset(a.asset as NewAsset);
  },
  async extract_skills(service, a) {
    return service.extractSkills({
      limit: optionalNum(a.limit),
      includePending: optionalBool(a.includePending),
    });
  },
  async extract_codegraph(service, a) {
    return service.extractCodegraph({ limit: optionalNum(a.limit) });
  },
  async extract_wiki(service, a) {
    return service.extractWiki({ limit: optionalNum(a.limit) });
  },
  async precipitate(service, a) {
    return service.autoPrecipitate({
      mode: a.mode === undefined ? undefined : (a.mode as 'fast' | 'auto' | 'full'),
    });
  },
  async import_directory(service, a) {
    return service.importDirectory({
      path: String(a.path),
      extensions: Array.isArray(a.extensions) ? a.extensions.map(String) : undefined,
      extract: optionalBool(a.extract),
    });
  },
  async import_codebase(service, a) {
    return service.importCodebase({
      path: String(a.path),
      extensions: Array.isArray(a.extensions) ? a.extensions.map(String) : undefined,
      maxFiles: optionalNum(a.maxFiles),
    });
  },
  async import_sessions(service, a) {
    return service.importSessions({
      path: String(a.path),
      format: a.format === undefined ? undefined : (a.format as 'auto' | 'jsonl' | 'json' | 'txt'),
      sessionLabel: optionalStr(a.sessionLabel),
      extract: optionalBool(a.extract),
    });
  },
  async seed(service, a) {
    return service.seed({
      sessionsPath: optionalStr(a.sessionsPath),
      docsPath: optionalStr(a.docsPath),
      codebasePath: optionalStr(a.codebasePath),
      sessionLabel: optionalStr(a.sessionLabel),
      precipitate: optionalBool(a.precipitate),
      persona: optionalBool(a.persona),
    });
  },
  async review_unit(service, a) {
    return service.reviewUnit(String(a.id), a.action as 'accept' | 'discard');
  },
  async forget(service, a) {
    await service.forget(String(a.id), String(a.reason));
    return {};
  },
  async classify_units(service, a) {
    return service.classifyUnits({
      ids: Array.isArray(a.ids) ? a.ids.map(String) : undefined,
      mode: a.mode === undefined ? undefined : (a.mode as 'rules' | 'llm' | 'auto'),
      reclassify: optionalBool(a.reclassify),
    });
  },
  async batch_units(service, a) {
    return service.batchUnits({
      ids: (a.ids as string[]).map(String),
      action: a.action as 'archive' | 'restore' | 'delete' | 'accept',
    });
  },
  async curate(service, a) {
    return service.curate(a.preset === undefined ? undefined : (a.preset as 'fast' | 'full'));
  },
  async stats(service) {
    return service.stats();
  },
  async activity(service, a) {
    return service.activity({
      kind: optionalStr(a.kind),
      limit: optionalNum(a.limit),
    });
  },
  async export(service) {
    return service.export();
  },
  async import(service, a) {
    return service.import(a.bundle as ExportBundle);
  },
  async health(service) {
    return service.health();
  },
};

/** Error thrown by the dispatcher carrying an MCP-style code. */
export class ToolError extends Error {
  readonly errorData: { code: string };
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.errorData = { code };
  }
}

/** Full list of MCP tool definitions (inputSchema as JSON Schema). */
export function toolDefs(_service: AmemService): ToolDefinition[] {
  return TOOL_NAMES.map((name) => {
    const schema = toolSchemas[name] as unknown as AnyObjectSchema;
    return {
      name,
      description: DESCRIPTIONS[name],
      inputSchema: toJsonSchemaCompat(schema) as unknown as Record<string, unknown>,
    };
  });
}

/** Dispatches a tool name + JSON args to a service call, returning MCP content. */
export async function callTool(
  service: AmemService,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const executor = executors[name as ToolName];
  if (!executor) {
    throw new ToolError('NOT_FOUND', `Unknown tool: ${name}`);
  }
  try {
    const result = await executor(service, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    if (error instanceof AmemError) {
      throw new ToolError(error.code, error.message);
    }
    throw new ToolError(
      'INTERNAL',
      error instanceof Error ? error.message : String(error),
    );
  }
}
