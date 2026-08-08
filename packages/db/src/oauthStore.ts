import { randomUUID } from 'node:crypto';
import type { Database as SqliteDatabase } from 'better-sqlite3';

export class OauthStore {
  constructor(private readonly db: SqliteDatabase) {}

  ensureWebClient(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO oauth_clients
         (client_id, client_name, client_secret_hash, redirect_uris, grants, scopes, public, owner_user_id, created_at, updated_at)
         VALUES
         ('amem-web', 'Amem Web UI', NULL, ?, '["authorization_code","refresh_token"]', '["read","write","admin"]', 1, NULL, ?, ?)`,
      )
      .run(
        JSON.stringify([
          'http://127.0.0.1:8321/oauth/callback',
          'http://localhost:8321/oauth/callback',
          'http://127.0.0.1:5173/oauth/callback',
        ]),
        now,
        now,
      );
  }

  getOauthClient(clientId: string) {
    return (this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as any) || null;
  }

  saveOauthCode(input: {
    codeHash: string;
    clientId: string;
    userId: string;
    scopes: string[];
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    workspaceIds: string[];
    expiresAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes
         (code_hash, client_id, user_id, scopes, redirect_uri, code_challenge, code_challenge_method, workspace_ids, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.codeHash,
        input.clientId,
        input.userId,
        JSON.stringify(input.scopes),
        input.redirectUri,
        input.codeChallenge,
        input.codeChallengeMethod,
        JSON.stringify(input.workspaceIds),
        input.expiresAt,
      );
  }

  consumeOauthCode(codeHash: string) {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash) as any;
    if (!row || row.used_at) return null;
    if (Date.parse(row.expires_at) < Date.now()) return null;
    this.db
      .prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?')
      .run(new Date().toISOString(), codeHash);
    return row as {
      client_id: string;
      user_id: string;
      scopes: string;
      redirect_uri: string;
      code_challenge: string;
      code_challenge_method: string;
      workspace_ids: string;
      expires_at: string;
      used_at: string | null;
    };
  }

  saveOauthToken(input: {
    id: string;
    tokenHash: string;
    clientId: string | null;
    userId: string;
    type: 'access' | 'refresh';
    scopes: string[];
    workspaceIds: string[];
    expiresAt: string;
    familyId: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens
         (id, token_hash, client_id, user_id, type, scopes, workspace_ids, expires_at, family_id, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        input.id,
        input.tokenHash,
        input.clientId,
        input.userId,
        input.type,
        JSON.stringify(input.scopes),
        JSON.stringify(input.workspaceIds),
        input.expiresAt,
        input.familyId,
        new Date().toISOString(),
      );
  }

  findOauthToken(tokenHash: string, type?: 'access' | 'refresh') {
    const row = (
      type
        ? this.db
            .prepare(
              `SELECT * FROM oauth_tokens WHERE token_hash = ? AND type = ? AND revoked_at IS NULL`,
            )
            .get(tokenHash, type)
        : this.db
            .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
            .get(tokenHash)
    ) as any;
    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now()) return null;
    return row as {
      id: string;
      token_hash: string;
      client_id: string | null;
      user_id: string;
      type: 'access' | 'refresh';
      scopes: string;
      workspace_ids: string;
      expires_at: string;
      family_id: string;
      revoked_at: string | null;
    };
  }

  findOauthTokenIncludingRevoked(tokenHash: string, type: 'access' | 'refresh') {
    const row = this.db
      .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND type = ?`)
      .get(tokenHash, type) as any;
    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now()) return null;
    return row as {
      id: string;
      token_hash: string;
      client_id: string | null;
      user_id: string;
      type: 'access' | 'refresh';
      scopes: string;
      workspace_ids: string;
      expires_at: string;
      family_id: string;
      used_at: string | null;
      revoked_at: string | null;
    };
  }

  touchOauthToken(id: string): void {
    this.db
      .prepare(`UPDATE oauth_tokens SET used_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), id);
  }

  revokeOauthFamily(familyId: string): void {
    this.db
      .prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), familyId);
  }

  revokeOauthTokenHash(tokenHash: string): void {
    const row = this.findOauthToken(tokenHash);
    if (!row) {
      this.db
        .prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
        .run(new Date().toISOString(), tokenHash);
      return;
    }
    this.revokeOauthFamily(row.family_id);
  }

  listUserOauthTokens(userId: string) {
    const rows = this.db
      .prepare(
        `SELECT * FROM oauth_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .all(userId) as Array<{
      id: string;
      client_id: string | null;
      type: 'access' | 'refresh';
      scopes: string;
      workspace_ids: string;
      expires_at: string;
      family_id: string;
      used_at: string | null;
      created_at: string;
    }>;
    return rows.filter((r) => Date.parse(r.expires_at) >= Date.now());
  }

  revokeOauthTokenById(userId: string, id: string): boolean {
    const row = this.db
      .prepare(`SELECT family_id FROM oauth_tokens WHERE id = ? AND user_id = ?`)
      .get(id, userId) as { family_id: string } | undefined;
    if (!row) return false;
    this.revokeOauthFamily(row.family_id);
    return true;
  }

  listLoginSessions(userId: string) {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, expires_at, created_at, revoked_at FROM login_sessions
         WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .all(userId) as Array<{
      id: string;
      user_id: string;
      expires_at: string;
      created_at: string;
      revoked_at: string | null;
    }>;
    return rows.filter((r) => Date.parse(r.expires_at) >= Date.now());
  }

  revokeLoginSessionById(userId: string, id: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE login_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), id, userId);
    return res.changes > 0;
  }

  createLoginSession(userId: string, tokenHash: string, ttlHours = 24 * 14): string {
    const id = `sess_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + ttlHours * 3600e3).toISOString();
    this.db
      .prepare(
        `INSERT INTO login_sessions (id, user_id, token_hash, expires_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, userId, tokenHash, expires, now);
    return id;
  }

  findLoginSession(tokenHash: string): { id: string; user_id: string } | null {
    const row = this.db
      .prepare(`SELECT id, user_id, expires_at, revoked_at FROM login_sessions WHERE token_hash = ?`)
      .get(tokenHash) as any;
    if (!row || row.revoked_at) return null;
    if (Date.parse(row.expires_at) < Date.now()) return null;
    return { id: row.id, user_id: row.user_id };
  }

  revokeLoginSession(tokenHash: string): void {
    this.db
      .prepare(`UPDATE login_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), tokenHash);
  }
}
