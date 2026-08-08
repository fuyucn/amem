import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_SLUG } from '@amem/core';

export type WorkspaceKind = 'personal' | 'company';
export type MemberRole = 'owner' | 'admin' | 'member' | 'reader';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  realm: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  kind: WorkspaceKind;
  owner_user_id: string | null;
  labels: string;
  created_at: string;
  updated_at: string;
}

export interface ApiTokenRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  user_id: string;
  scopes: string;
  workspace_ids: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export function hashPassword(password: string, salt?: Buffer): string {
  const s = salt ?? randomBytes(16);
  const hash = scryptSync(password, s, 32);
  return `scrypt$${s.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [kind, saltB64, hashB64] = encoded.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

export function hashToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function newPatPlaintext(): { token: string; prefix: string } {
  const raw = randomBytes(24).toString('base64url');
  const token = `amem_pat_${raw}`;
  return { token, prefix: token.slice(0, 16) };
}

export class AuthStore {
  constructor(private readonly db: SqliteDatabase) {}

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return row.c;
  }

  getUserByEmail(email: string): UserRow | null {
    return (
      (this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as
        | UserRow
        | undefined) ?? null
    );
  }

  getUserById(id: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  createUser(input: { email: string; password: string; name?: string }): UserRow {
    const now = new Date().toISOString();
    const row: UserRow = {
      id: `user_${randomUUID().slice(0, 8)}`,
      email: input.email.toLowerCase(),
      password_hash: hashPassword(input.password),
      name: input.name ?? null,
      realm: 'local',
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, name, realm, created_at, updated_at)
         VALUES (@id, @email, @password_hash, @name, @realm, @created_at, @updated_at)`,
      )
      .run(row);
    return row;
  }

  ensurePersonalWorkspace(userId: string, name = 'Personal'): WorkspaceRow {
    const existing = this.db
      .prepare(`SELECT w.* FROM workspaces w
                JOIN workspace_members m ON m.workspace_id = w.id
                WHERE m.user_id = ? AND w.kind = 'personal' LIMIT 1`)
      .get(userId) as WorkspaceRow | undefined;
    if (existing) return existing;

    // Prefer canonical default workspace for first user.
    let ws = this.getWorkspaceById(DEFAULT_WORKSPACE_ID);
    const now = new Date().toISOString();
    if (!ws) {
      ws = {
        id: DEFAULT_WORKSPACE_ID,
        slug: DEFAULT_WORKSPACE_SLUG,
        name,
        kind: 'personal',
        owner_user_id: userId,
        labels: '{}',
        created_at: now,
        updated_at: now,
      };
      this.db
        .prepare(
          `INSERT INTO workspaces (id, slug, name, kind, owner_user_id, labels, created_at, updated_at)
           VALUES (@id, @slug, @name, @kind, @owner_user_id, @labels, @created_at, @updated_at)`,
        )
        .run(ws);
    } else if (!ws.owner_user_id) {
      this.db.prepare(`UPDATE workspaces SET owner_user_id = ?, updated_at = ? WHERE id = ?`).run(userId, now, ws.id);
      ws = { ...ws, owner_user_id: userId, updated_at: now };
    } else {
      // create a dedicated personal ws
      const slug = `personal-${userId.slice(-6)}`;
      ws = {
        id: `ws_${randomUUID().slice(0, 8)}`,
        slug,
        name,
        kind: 'personal',
        owner_user_id: userId,
        labels: '{}',
        created_at: now,
        updated_at: now,
      };
      this.db
        .prepare(
          `INSERT INTO workspaces (id, slug, name, kind, owner_user_id, labels, created_at, updated_at)
           VALUES (@id, @slug, @name, @kind, @owner_user_id, @labels, @created_at, @updated_at)`,
        )
        .run(ws);
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .run(ws.id, userId, now);
    return ws;
  }

  createWorkspace(input: {
    slug: string;
    name: string;
    kind: WorkspaceKind;
    ownerUserId: string;
  }): WorkspaceRow {
    const now = new Date().toISOString();
    const row: WorkspaceRow = {
      id: `ws_${randomUUID().slice(0, 8)}`,
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      owner_user_id: input.ownerUserId,
      labels: '{}',
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO workspaces (id, slug, name, kind, owner_user_id, labels, created_at, updated_at)
         VALUES (@id, @slug, @name, @kind, @owner_user_id, @labels, @created_at, @updated_at)`,
      )
      .run(row);
    this.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .run(row.id, input.ownerUserId, now);
    return row;
  }

  listWorkspacesForUser(userId: string): WorkspaceRow[] {
    return this.db
      .prepare(
        `SELECT w.* FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_id = ?
         ORDER BY w.created_at ASC`,
      )
      .all(userId) as WorkspaceRow[];
  }

  getWorkspaceBySlug(slug: string): WorkspaceRow | null {
    return (
      (this.db.prepare('SELECT * FROM workspaces WHERE slug = ?').get(slug) as WorkspaceRow | undefined) ??
      null
    );
  }

  getWorkspaceById(id: string): WorkspaceRow | null {
    return (
      (this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined) ?? null
    );
  }

  memberRole(workspaceId: string, userId: string): MemberRole | null {
    const row = this.db
      .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, userId) as { role: MemberRole } | undefined;
    return row?.role ?? null;
  }


  listMembers(workspaceId: string): Array<{ userId: string; email: string; name: string | null; role: MemberRole; createdAt: string }> {
    return (
      this.db
        .prepare(
          `SELECT m.user_id as userId, u.email as email, u.name as name, m.role as role, m.created_at as createdAt
           FROM workspace_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.workspace_id = ?
           ORDER BY m.created_at ASC`,
        )
        .all(workspaceId) as Array<{ userId: string; email: string; name: string | null; role: MemberRole; createdAt: string }>
    );
  }

  upsertMember(workspaceId: string, userId: string, role: MemberRole): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(workspaceId, userId, role, now);
  }

  removeMember(workspaceId: string, userId: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .run(workspaceId, userId);
    return res.changes > 0;
  }

  findUserByEmail(email: string): UserRow | null {
    return this.getUserByEmail(email);
  }

  createPat(input: {
    userId: string;
    name: string;
    scopes: string[];
    workspaceIds: string[];
    secret: string;
    ttlDays?: number;
  }): { row: ApiTokenRow; token: string } {
    const { token, prefix } = newPatPlaintext();
    const now = new Date().toISOString();
    let expires: string | null = null;
    if (input.ttlDays && input.ttlDays > 0) {
      expires = new Date(Date.now() + input.ttlDays * 864e5).toISOString();
    }
    const row: ApiTokenRow = {
      id: `pat_${randomUUID().slice(0, 8)}`,
      name: input.name,
      token_hash: hashToken(input.secret, token),
      token_prefix: prefix,
      user_id: input.userId,
      scopes: JSON.stringify(input.scopes),
      workspace_ids: JSON.stringify(input.workspaceIds),
      created_at: now,
      last_used_at: null,
      expires_at: expires,
      revoked_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO api_tokens
         (id, name, token_hash, token_prefix, user_id, scopes, workspace_ids, created_at, last_used_at, expires_at, revoked_at)
         VALUES
         (@id, @name, @token_hash, @token_prefix, @user_id, @scopes, @workspace_ids, @created_at, @last_used_at, @expires_at, @revoked_at)`,
      )
      .run(row);
    return { row, token };
  }

  listPats(userId: string): ApiTokenRow[] {
    return this.db
      .prepare(
        `SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .all(userId) as ApiTokenRow[];
  }

  revokePat(userId: string, tokenId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), tokenId, userId);
    return res.changes > 0;
  }

  findPatByToken(secret: string, token: string): ApiTokenRow | null {
    const hash = hashToken(secret, token);
    const row = this.db
      .prepare(`SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(hash) as ApiTokenRow | undefined;
    if (!row) return null;
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
    this.db
      .prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), row.id);
    return row;
  }
}
