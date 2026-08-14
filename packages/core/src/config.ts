import type { AmemConfig, EmbeddingMode } from './domain.js';

const env = (k: string): string | undefined => process.env[k];
const num = (v: string | undefined, d: number): number => (v === undefined ? d : Number(v));
const bool = (v: string | undefined, d: boolean): boolean => (v === undefined ? d : v.toLowerCase() === 'true');

function resolveEmbeddingMode(explicit: string | undefined, hasBaseUrl: boolean): EmbeddingMode {
  if (explicit === 'api' || explicit === 'offline') return explicit;
  return hasBaseUrl ? 'api' : 'offline';
}

export const DEFAULT_CONFIG: AmemConfig = {
  dbPath: './data/amem.db',
  host: '127.0.0.1',
  port: 8321,
  apiToken: undefined,
  corsOrigin: undefined,
  authEnabled: false,
  trustProxy: false,
  cookieSecure: false,
  authSecret: undefined,
  allowLegacyApiToken: true,
  bootstrapAdminEmail: 'admin@localhost',
  bootstrapAdminPassword: 'admin',
  patDefaultTtlDays: 90,
  rateLimit: {
    enabled: true,
    loginPerMinute: 10,
    bootstrapPerHour: 3,
    oauthPerMinute: 20,
    registerPerHour: 10,
  },
  embedding: {
    mode: 'offline',
    baseUrl: undefined,
    model: undefined,
    apiKey: undefined,
    dims: 64,
  },
  llm: { baseUrl: undefined, model: undefined, apiKey: undefined },
  ocr: { baseUrl: undefined, apiKey: undefined, model: undefined, minChars: 60 },
  thresholds: {
    minSourcesForCrystal: 3,
    dedupSimThreshold: 0.9,
    linkSimThreshold: 0.72,
    minSharedTags: 3,
    maxLinksPerUnit: 8,
    contradictionThreshold: 0.6,
    decayPerDay: 0.02,
    forgetThreshold: 0.3,
    workingMemoryBudget: 3000,
    recallBudget: 4000,
    codeSymbolPenalty: 0.18,
    knowledgeBoost: 0.06,
    maxScenarios: 12,
  },
  jobs: {
    enabled: true,
    debounceMs: 5000,
    intervalMs: 30000,
    maxPerHour: 60,
    tokenBudgetDaily: 200_000,
  },
  autoPrecipitate: {
    enabled: false,
    mode: 'fast',
    minIntervalMs: 60_000,
  },
};

/** Build config from process.env with sensible defaults. Zero-config local mode. */
export function configFromEnv(): AmemConfig {
  const embeddingBaseUrl = env('AMEM_EMBEDDING_BASE_URL');
  const authEnabled = bool(env('AMEM_AUTH_ENABLED'), DEFAULT_CONFIG.authEnabled ?? false);
  // After migrating to real user accounts, the legacy global token defaults to
  // OFF unless the operator explicitly opts back in.
  const legacyEnv = env('AMEM_ALLOW_LEGACY_API_TOKEN');
  const allowLegacyApiToken = legacyEnv !== undefined ? bool(legacyEnv, true) : !authEnabled;
  return {
    dbPath: env('AMEM_DB_PATH') ?? DEFAULT_CONFIG.dbPath,
    host: env('AMEM_HOST') ?? DEFAULT_CONFIG.host,
    port: num(env('AMEM_PORT'), DEFAULT_CONFIG.port),
    apiToken: env('AMEM_API_TOKEN') || undefined,
    corsOrigin: env('AMEM_CORS_ORIGIN') || undefined,
    authEnabled,
    trustProxy: bool(env('AMEM_TRUST_PROXY'), DEFAULT_CONFIG.trustProxy ?? false),
    cookieSecure: bool(env('AMEM_COOKIE_SECURE'), DEFAULT_CONFIG.cookieSecure ?? false),
    authSecret: env('AMEM_AUTH_SECRET') || undefined,
    allowLegacyApiToken,
    bootstrapAdminEmail: env('AMEM_BOOTSTRAP_ADMIN_EMAIL') || DEFAULT_CONFIG.bootstrapAdminEmail,
    bootstrapAdminPassword: env('AMEM_BOOTSTRAP_ADMIN_PASSWORD') || DEFAULT_CONFIG.bootstrapAdminPassword,
    patDefaultTtlDays: num(env('AMEM_PAT_DEFAULT_TTL_DAYS'), DEFAULT_CONFIG.patDefaultTtlDays ?? 90),
    rateLimit: {
      enabled: bool(env('AMEM_RATE_LIMIT_ENABLED'), DEFAULT_CONFIG.rateLimit?.enabled ?? true),
      loginPerMinute: num(
        env('AMEM_RATE_LIMIT_LOGIN_PER_MINUTE'),
        DEFAULT_CONFIG.rateLimit?.loginPerMinute ?? 10,
      ),
      bootstrapPerHour: num(
        env('AMEM_RATE_LIMIT_BOOTSTRAP_PER_HOUR'),
        DEFAULT_CONFIG.rateLimit?.bootstrapPerHour ?? 3,
      ),
      oauthPerMinute: num(
        env('AMEM_RATE_LIMIT_OAUTH_PER_MINUTE'),
        DEFAULT_CONFIG.rateLimit?.oauthPerMinute ?? 20,
      ),
      registerPerHour: num(
        env('AMEM_RATE_LIMIT_REGISTER_PER_HOUR'),
        DEFAULT_CONFIG.rateLimit?.registerPerHour ?? 10,
      ),
    },
    embedding: {
      mode: resolveEmbeddingMode(env('AMEM_EMBEDDING_MODE'), Boolean(embeddingBaseUrl)),
      baseUrl: embeddingBaseUrl,
      model: env('AMEM_EMBEDDING_MODEL'),
      apiKey: env('AMEM_EMBEDDING_API_KEY'),
      dims: num(env('AMEM_EMBEDDING_DIMS'), DEFAULT_CONFIG.embedding.dims ?? 64),
    },
    llm: {
      baseUrl: env('AMEM_LLM_BASE_URL'),
      model: env('AMEM_LLM_MODEL'),
      apiKey: env('AMEM_LLM_API_KEY'),
    },
    ocr: {
      baseUrl: env('AMEM_OCR_BASE_URL') || undefined,
      apiKey: env('AMEM_OCR_API_KEY') || undefined,
      model: env('AMEM_OCR_MODEL') || undefined,
      minChars: num(env('AMEM_OCR_MIN_CHARS'), DEFAULT_CONFIG.ocr?.minChars ?? 60),
    },
    thresholds: {
      minSourcesForCrystal: num(
        env('AMEM_MIN_SOURCES_FOR_CRYSTAL'),
        DEFAULT_CONFIG.thresholds.minSourcesForCrystal,
      ),
      dedupSimThreshold: num(
        env('AMEM_DEDUP_SIM_THRESHOLD'),
        DEFAULT_CONFIG.thresholds.dedupSimThreshold,
      ),
      linkSimThreshold: num(
        env('AMEM_LINK_SIM_THRESHOLD'),
        DEFAULT_CONFIG.thresholds.linkSimThreshold,
      ),
      minSharedTags: num(
        env('AMEM_MIN_SHARED_TAGS'),
        DEFAULT_CONFIG.thresholds.minSharedTags,
      ),
      maxLinksPerUnit: num(
        env('AMEM_MAX_LINKS_PER_UNIT'),
        DEFAULT_CONFIG.thresholds.maxLinksPerUnit,
      ),
      contradictionThreshold: num(
        env('AMEM_CONTRADICTION_THRESHOLD'),
        DEFAULT_CONFIG.thresholds.contradictionThreshold,
      ),
      decayPerDay: num(env('AMEM_DECAY_PER_DAY'), DEFAULT_CONFIG.thresholds.decayPerDay),
      forgetThreshold: num(env('AMEM_FORGET_THRESHOLD'), DEFAULT_CONFIG.thresholds.forgetThreshold),
      workingMemoryBudget: num(
        env('AMEM_WORKING_MEMORY_BUDGET'),
        DEFAULT_CONFIG.thresholds.workingMemoryBudget,
      ),
      recallBudget: num(env('AMEM_RECALL_BUDGET'), DEFAULT_CONFIG.thresholds.recallBudget),
      codeSymbolPenalty: num(
        env('AMEM_CODE_SYMBOL_PENALTY'),
        DEFAULT_CONFIG.thresholds.codeSymbolPenalty,
      ),
      knowledgeBoost: num(
        env('AMEM_KNOWLEDGE_BOOST'),
        DEFAULT_CONFIG.thresholds.knowledgeBoost,
      ),
      maxScenarios: num(env('AMEM_MAX_SCENARIOS'), DEFAULT_CONFIG.thresholds.maxScenarios),
    },
    jobs: {
      enabled: bool(env('AMEM_JOBS_ENABLED'), DEFAULT_CONFIG.jobs.enabled),
      debounceMs: num(env('AMEM_JOBS_DEBOUNCE_MS'), DEFAULT_CONFIG.jobs.debounceMs),
      intervalMs: num(env('AMEM_JOBS_INTERVAL_MS'), DEFAULT_CONFIG.jobs.intervalMs),
      maxPerHour: num(env('AMEM_JOBS_MAX_PER_HOUR'), DEFAULT_CONFIG.jobs.maxPerHour),
      tokenBudgetDaily: num(env('AMEM_JOBS_TOKEN_BUDGET_DAILY'), DEFAULT_CONFIG.jobs.tokenBudgetDaily),
    },
    autoPrecipitate: resolveAutoPrecipitate(env('AMEM_AUTO_PRECIPITATE')),
  };
}

function resolveAutoPrecipitate(raw: string | undefined): AmemConfig['autoPrecipitate'] {
  const base = DEFAULT_CONFIG.autoPrecipitate;
  if (raw === undefined || raw === '') return base;
  const v = raw.toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') {
    return { ...base, enabled: false };
  }
  const mode = v === 'full' || v === 'auto' ? v : 'fast';
  const minIntervalMs = num(
    process.env.AMEM_AUTO_PRECIPITATE_MIN_INTERVAL_MS,
    base?.minIntervalMs ?? 60_000,
  );
  return { enabled: true, mode, minIntervalMs };
}

export function mergeConfig(partial?: Partial<AmemConfig>): AmemConfig {
  if (!partial) return DEFAULT_CONFIG;
  const base = DEFAULT_CONFIG;
  return {
    ...base,
    ...partial,
    embedding: { ...base.embedding, ...partial.embedding },
    llm: { ...base.llm, ...partial.llm },
    ocr: { ...base.ocr, ...partial.ocr },
    thresholds: { ...base.thresholds, ...partial.thresholds },
    jobs: { ...base.jobs, ...partial.jobs },
    rateLimit: { ...base.rateLimit, ...partial.rateLimit },
    autoPrecipitate: { ...base.autoPrecipitate, ...partial.autoPrecipitate },
  };
}
