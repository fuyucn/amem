import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * Seed the default zones for every workspace and workspace member.
 *
 * Deterministic ids (zones.id is a global PK, so a bare literal like
 * `z_inbox` can never be used):
 *   - z_inbox_<workspaceId>   kind=inbox    visibility=workspace (all members)
 *   - z_shared_<workspaceId>  kind=shared   visibility=workspace (all members)
 *   - z_personal_<userId>_<workspaceId> kind=personal visibility=private (owner only)
 *
 * The personal id is workspace-qualified because zones.id is a global PK and
 * a user is a member of many workspaces (their own personal workspace plus
 * every company workspace they join); a bare `z_personal_<userId>` would
 * collide across workspaces and silently drop the second personal zone.
 *
 * Also backfills any unit whose zone_id does not reference a real zone row
 * (e.g. legacy rows created before the column existed, which carry the
 * literal default) to its workspace's inbox zone. Idempotent: re-running is
 * a no-op apart from the backfill converging stragglers.
 */
export function seedDefaultZones(db: SqliteDatabase, workspaceId?: string): void {
  const now = new Date().toISOString();
  const insertZone = db.prepare(`
    INSERT OR IGNORE INTO zones
      (id, workspace_id, slug, name, kind, owner_user_id, visibility, description, embedding_centroid, auto, status, created_at, updated_at)
    VALUES
      (@id, @workspace_id, @slug, @name, @kind, @owner_user_id, @visibility, @description, NULL, 0, 'active', @created_at, @updated_at)
  `);
  const insertMember = db.prepare(`
    INSERT OR IGNORE INTO zone_members (zone_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?)
  `);

  const workspaces = (
    workspaceId
      ? db.prepare('SELECT id FROM workspaces WHERE id = ?').all(workspaceId)
      : db.prepare('SELECT id FROM workspaces').all()
  ) as Array<{ id: string }>;
  for (const ws of workspaces) {
    insertZone.run({
      id: `z_inbox_${ws.id}`,
      workspace_id: ws.id,
      slug: 'inbox',
      name: 'Inbox',
      kind: 'inbox',
      owner_user_id: null,
      visibility: 'workspace',
      description: 'Uncategorized memory awaiting assignment',
      created_at: now,
      updated_at: now,
    });
    insertZone.run({
      id: `z_shared_${ws.id}`,
      workspace_id: ws.id,
      slug: 'shared',
      name: 'Shared',
      kind: 'shared',
      owner_user_id: null,
      visibility: 'workspace',
      description: 'Shared across all workspace members',
      created_at: now,
      updated_at: now,
    });
  }

  const members = (
    workspaceId
      ? db.prepare('SELECT workspace_id, user_id FROM workspace_members WHERE workspace_id = ?').all(workspaceId)
      : db.prepare('SELECT workspace_id, user_id FROM workspace_members').all()
  ) as Array<{ workspace_id: string; user_id: string }>;
  for (const m of members) {
    const id = `z_personal_${m.user_id}_${m.workspace_id}`;
    insertZone.run({
      id,
      workspace_id: m.workspace_id,
      slug: `personal-${m.user_id}`,
      name: 'Personal',
      kind: 'personal',
      owner_user_id: m.user_id,
      visibility: 'private',
      description: 'Private memory, visible only to the owner',
      created_at: now,
      updated_at: now,
    });
    insertMember.run(id, m.user_id, 'owner', now);
  }

  const backfill = `
    UPDATE units
    SET zone_id = (
      SELECT z.id FROM zones z
      WHERE z.workspace_id = units.workspace_id AND z.kind = 'inbox'
    )
    WHERE units.zone_id NOT IN (SELECT id FROM zones)
  `;
  if (workspaceId) {
    db.prepare(`${backfill} AND workspace_id = ?`).run(workspaceId);
  } else {
    db.exec(backfill);
  }
}
