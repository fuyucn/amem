import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * Current schema version. Bump this when appending a new migration so that
 * `migrate` upgrades existing databases in place.
 */
export const SCHEMA_VERSION = 13;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS w_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  agent      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_type TEXT NOT NULL,
  token_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,
  uri            TEXT,
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  content_length INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  form         TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL,
  quality      REAL NOT NULL DEFAULT 0,
  confidence   REAL NOT NULL DEFAULT 0,
  embedding    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  valid_from   TEXT,
  valid_to     TEXT,
  source_count INTEGER NOT NULL DEFAULT 0,
  importance   REAL NOT NULL DEFAULT 0,
  decay        REAL NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  labels       TEXT NOT NULL DEFAULT '{}',
  tags         TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS unit_sources (
  unit_id    TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  span       TEXT,
  asserted_at TEXT NOT NULL,
  PRIMARY KEY (unit_id, source_id),
  FOREIGN KEY (unit_id) REFERENCES units(id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS links (
  id             TEXT PRIMARY KEY,
  source_unit_id TEXT NOT NULL,
  target_unit_id TEXT NOT NULL,
  relation       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0,
  auto           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  UNIQUE (source_unit_id, target_unit_id, relation),
  FOREIGN KEY (source_unit_id) REFERENCES units(id),
  FOREIGN KEY (target_unit_id) REFERENCES units(id)
);

CREATE TABLE IF NOT EXISTS versions (
  id         TEXT PRIMARY KEY,
  unit_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (unit_id) REFERENCES units(id)
);

CREATE TABLE IF NOT EXISTS tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS unit_tags (
  unit_id TEXT NOT NULL,
  tag_id  TEXT NOT NULL,
  PRIMARY KEY (unit_id, tag_id),
  FOREIGN KEY (unit_id) REFERENCES units(id),
  FOREIGN KEY (tag_id) REFERENCES tags(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  meta        TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(
  title,
  summary,
  body,
  content='units',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS units_ai AFTER INSERT ON units BEGIN
  INSERT INTO units_fts(rowid, title, summary, body)
  VALUES (new.rowid, new.title, new.summary, new.body);
END;

CREATE TRIGGER IF NOT EXISTS units_ad AFTER DELETE ON units BEGIN
  INSERT INTO units_fts(units_fts, rowid, title, summary, body)
  VALUES ('delete', old.rowid, old.title, old.summary, old.body);
END;

CREATE TRIGGER IF NOT EXISTS units_au AFTER UPDATE ON units BEGIN
  INSERT INTO units_fts(units_fts, rowid, title, summary, body)
  VALUES ('delete', old.rowid, old.title, old.summary, old.body);
  INSERT INTO units_fts(rowid, title, summary, body)
  VALUES (new.rowid, new.title, new.summary, new.body);
END;
`;


const EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  summary    TEXT NOT NULL,
  actor      TEXT,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
`;


const AUTH_WORKSPACE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  realm TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('personal','company')),
  owner_user_id TEXT,
  labels TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','reader')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  workspace_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

-- workspace_id columns (SQLite ignores IF NOT EXISTS on ADD COLUMN before 3.35; use try in migrate code path via plain ADD and ignore errors)
`;


const OAUTH_SQL = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_secret_hash TEXT,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  grants TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  scopes TEXT NOT NULL DEFAULT '["read","write"]',
  public INTEGER NOT NULL DEFAULT 1,
  owner_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  workspace_ids TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('access','refresh')),
  scopes TEXT NOT NULL DEFAULT '[]',
  workspace_ids TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  family_id TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id);
`;

const OAUTH_USED_AT_SQL = `-- Migration 4: oauth_tokens.used_at (applied via addColumnIfMissing in migrate()).`;

const AI_PROVIDERS_EMBEDDING_SQL = `-- Migration 6: ai_providers.embedding_model (applied via addColumnIfMissing in migrate()).`;
const AI_PROVIDERS_EMBEDDING_ENDPOINT_SQL = `-- Migration 7: ai_providers.embedding_base_url / embedding_api_key (applied via addColumnIfMissing in migrate()).`;

const AI_PROVIDERS_SQL = `
CREATE TABLE IF NOT EXISTS ai_providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'openai_compatible',
  base_url   TEXT NOT NULL,
  model      TEXT NOT NULL,
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_base_url TEXT NOT NULL DEFAULT '',
  embedding_api_key TEXT NOT NULL DEFAULT '',
  api_key    TEXT NOT NULL DEFAULT '',
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** L2/L3 layers + portable assets (migration 8). */
const LAYERS_ASSETS_SQL = `
CREATE TABLE IF NOT EXISTS scenarios (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL DEFAULT 'ws_personal',
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL DEFAULT '',
  content             TEXT NOT NULL DEFAULT '',
  tags                TEXT NOT NULL DEFAULT '[]',
  source_unit_ids     TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'active',
  version             INTEGER NOT NULL DEFAULT 1,
  heat                INTEGER NOT NULL DEFAULT 0,
  last_hit_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_consolidated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scenarios_workspace ON scenarios(workspace_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_status ON scenarios(workspace_id, status);

CREATE TABLE IF NOT EXISTS personas (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'ws_personal',
  content      TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personas_workspace ON personas(workspace_id);

CREATE TABLE IF NOT EXISTS assets (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL DEFAULT 'ws_personal',
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  trigger         TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT '[]',
  source_unit_ids TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'draft',
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_workspace ON assets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(workspace_id, kind, status);
`;

/**
 * Asset version chain (migration 10): immutable snapshots written before
 * content-bearing updates, so every Skill / Wiki / CodeGraph version stays
 * recoverable (Tencent skill-versioning semantics, SQLite-flavored).
 */
const ASSET_VERSIONS_SQL = `
CREATE TABLE IF NOT EXISTS asset_versions (
  id           TEXT PRIMARY KEY,
  asset_id     TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'ws_personal',
  version      INTEGER NOT NULL,
  snapshot     TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE INDEX IF NOT EXISTS idx_asset_versions_asset ON asset_versions(asset_id, workspace_id, version);
`;

/** Migration 12: hot read-path indexes. Query-path scans (listUnits by
 *  freshness, graph degree lookups, session traces, version history, reverse
 *  citation lookups) all previously walked full tables. */
const QUERY_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_units_workspace_status ON units(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_units_workspace_updated ON units(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_unit_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_unit_id);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_versions_unit ON versions(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_sources_source ON unit_sources(source_id);
`;

const MIGRATIONS: string[] = [
  SCHEMA_SQL,
  EVENTS_SQL,
  AUTH_WORKSPACE_SQL,
  OAUTH_SQL,
  OAUTH_USED_AT_SQL,
  AI_PROVIDERS_SQL,
  AI_PROVIDERS_EMBEDDING_SQL,
  AI_PROVIDERS_EMBEDDING_ENDPOINT_SQL,
  LAYERS_ASSETS_SQL,
  '-- migration 9 (asset routing) is applied imperatively below for idempotency',
  ASSET_VERSIONS_SQL,
  '-- migration 11 (scene heat) is applied imperatively below for idempotency',
  QUERY_INDEXES_SQL,
];

/**
 * Apply (or re-apply) the schema. Idempotent: uses `PRAGMA user_version` to
 * skip migrations that already ran, and all DDL is `IF NOT EXISTS`.
 */
function addColumnIfMissing(db: SqliteDatabase, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function migrate(db: SqliteDatabase): void {
  // TRUNCATE (not WAL): the DB file may be shared with host-side tools across
  // a bind mount (e.g. Docker Desktop virtiofs). WAL relies on -shm shared
  // memory which is not portable across the mount and has corrupted the file.
  db.pragma('journal_mode = TRUNCATE');
  db.pragma('busy_timeout = 15000');
  db.pragma('foreign_keys = ON');

  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < SCHEMA_VERSION; i++) {
    const sql = MIGRATIONS[i];
    if (!sql) throw new Error(`Missing migration ${i}`);
    db.exec(sql);
    if (i === 0) {
      // FTS5 depends on the units table created in migration 0; run it after.
      db.exec(FTS_SQL);
    }
    if (i === 2) {
      // workspace scoping columns + seed default workspace
      for (const table of ['units', 'links', 'traces', 'sessions', 'sources', 'versions', 'events']) {
        addColumnIfMissing(db, table, 'workspace_id', "TEXT NOT NULL DEFAULT 'ws_personal'");
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_workspace ON ${table}(workspace_id)`);
      }
      const now = new Date().toISOString();
      db.prepare(
        `INSERT OR IGNORE INTO workspaces (id, slug, name, kind, owner_user_id, labels, created_at, updated_at)
         VALUES ('ws_personal', 'personal', 'Personal', 'personal', NULL, '{}', ?, ?)`,
      ).run(now, now);
    }
    if (i === 3) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT OR IGNORE INTO oauth_clients
         (client_id, client_name, client_secret_hash, redirect_uris, grants, scopes, public, owner_user_id, created_at, updated_at)
         VALUES
         ('amem-web', 'Amem Web UI', NULL, ?, '["authorization_code","refresh_token"]', '["read","write","admin"]', 1, NULL, ?, ?)`,
      ).run(JSON.stringify(['http://127.0.0.1:8321/oauth/callback', 'http://localhost:8321/oauth/callback', 'http://127.0.0.1:5173/oauth/callback']), now, now);
    }
    if (i === 4) {
      addColumnIfMissing(db, 'oauth_tokens', 'used_at', 'TEXT');
    }
    if (i === 6) {
      addColumnIfMissing(db, 'ai_providers', 'embedding_model', "TEXT NOT NULL DEFAULT ''");
    }
    if (i === 7) {
      addColumnIfMissing(db, 'ai_providers', 'embedding_base_url', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'ai_providers', 'embedding_api_key', "TEXT NOT NULL DEFAULT ''");
    }
    if (i === 9) {
      addColumnIfMissing(db, 'assets', 'visibility', "TEXT NOT NULL DEFAULT 'workspace'");
      addColumnIfMissing(db, 'assets', 'bound_agents', "TEXT NOT NULL DEFAULT '[]'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_assets_visibility ON assets(workspace_id, visibility, status)');
    }
    if (i === 11) {
      addColumnIfMissing(db, 'scenarios', 'heat', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'scenarios', 'last_hit_at', 'TEXT');
    }
    db.pragma(`user_version = ${i + 1}`);
  }
}

/** Apply safe multi-process pragmas. Call after every open. */
export function configureSqliteConnection(db: SqliteDatabase): void {
  db.pragma('journal_mode = TRUNCATE');
  db.pragma('busy_timeout = 15000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
}

/**
 * Best-effort integrity probe. Returns "ok" or a short error string.
 * On FTS index damage, attempts a rebuild of units_fts.
 */
export function ensureSqliteHealthy(db: SqliteDatabase): string {
  try {
    const result = db.pragma('integrity_check', { simple: true }) as string;
    if (result === 'ok') return 'ok';
    // Common recoverable case: FTS inverted index after crash/dual-write.
    if (String(result).toLowerCase().includes('fts') || String(result).toLowerCase().includes('index')) {
      try {
        db.exec(`INSERT INTO units_fts(units_fts) VALUES('rebuild')`);
        const again = db.pragma('integrity_check', { simple: true }) as string;
        return again === 'ok' ? 'ok-after-fts-rebuild' : String(again);
      } catch (e) {
        return `integrity:${result}; fts-rebuild-failed:${e instanceof Error ? e.message : e}`;
      }
    }
    return String(result);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Open a SQLite database at the given path (no migration applied). */
export function openDatabase(dbPath: string): SqliteDatabase {
  const db = new Database(dbPath);
  configureSqliteConnection(db);
  return db;
}
