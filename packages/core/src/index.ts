export * from './domain.js';
export * from './errors.js';
export * from './config.js';
export {
  DEFAULT_EMBEDDING_DIMS,
  cosine,
  hashEmbed,
  normalize,
} from './lib/vector.js';
export { countTokens } from './lib/tokenizer.js';
export {
  type Embedder,
  OfflineEmbedder,
  ApiEmbedder,
  createEmbedder,
} from './embedder.js';
export {
  type LlmClient,
  LLM_EXTRACT_INTENT,
  LLM_ZONE_ASSIGN_INTENT,
  OpenAiCompatibleLlm,
  MockLlmClient,
  createLlm,
} from './llm.js';
export {
  type OcrClient,
  OpenAiCompatibleOcr,
  createOcrClient,
} from './ocr.js';
export {
  accessibleZones,
  getZoneAccess,
  getZoneAccessSync,
  resolveExplicitZone,
  resolveZoneForWrite,
  recomputeZoneCentroids,
  proposeNewZones,
  type ZoneAccess,
  type ZoneLookup,
  type ZoneProposal,
  type ZoneResolveOutcome,
  type ResolveZoneInput,
  type ProposeZonesOptions,
} from './zones.js';
export {
  type CandidateUnit,
  type DistillResult,
  distillUnits,
  heuristicExtract,
} from './distill.js';
export {
  type EmbeddableCandidate,
  type DuplicateMatch,
  type MergeSource,
  findDuplicate,
  mergeUnits,
} from './dedup.js';
export { generateLinks } from './linkgen.js';
export { recall, routeZone } from './recall.js';
export { layeredRecall } from './layeredRecall.js';
export {
  segmentTranscript,
  upsertScenes,
  extractScenesFromTranscript,
  type SceneSegment,
  type SceneOptions,
} from './scenes.js';
export {
  refreshLayers,
  personaTokenCount,
  LLM_SCENARIO_INTENT,
  LLM_PERSONA_INTENT,
} from './layers.js';
export { extractSkills, LLM_SKILL_INTENT } from './skills.js';
export { routeAssets, agentCanUse } from './route.js';
export { extractCodegraph } from './codegraph.js';
export { extractWiki } from './wiki.js';
export {
  importDirectory,
  importPdf,
  importCodebase,
  importSessions,
  type ImporterDeps,
} from './importer.js';
export { consolidate, type ConsolidateOptions } from './consolidate.js';
export { buildWorkingMemory } from './workingMemory.js';
export { renderOkfBundle, slugify } from './okf.js';
export {
  UNIT_CATEGORIES,
  type UnitCategory,
  LLM_CLASSIFY_INTENT,
  classifyUnit,
  classifyUnitRuleBased,
  classifyUnits,
  type ClassifyReport,
  type ClassifiableUnit,
  type ClassifyOutcome,
} from './classify.js';
export { detectCommunities, countCommunities, type CommunityEdge } from './lib/communities.js';
export { createService, type ServiceDeps } from './service.js';
export * from './store.js';
export * from './requestContext.js';
