import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Unit } from '@amem/core';
import { runWithRequestContextAsync } from '@amem/core';
import { createSqliteStorageFromPath, migrate, seedDefaultZones } from '../src/index.js';

const dirs: string[] = [];
function tmpDb(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'amem-zones-'));
  dirs.push(d);
  return join(d, name);
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function migratedDb(name: string): Database.Database {
  const db = new Database(tmpDb(name));
  migrate(db);
  return db;
}

function addMember(db: Database.Database, workspaceId: string, userId: string, role: string): void {
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
  ).run(workspaceId, userId, role, '2026-01-01T00:00:00.000Z');
}

function addWorkspace(db: Database.Database, id: string, slug: string, name: string, owner: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, kind, owner_user_id, labels, created_at, updated_at)
     VALUES (?, ?, ?, 'company', ?, '{}', ?, ?)`,
  ).run(id, slug, name, owner, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  addMember(db, id, owner, 'owner');
}

describe('schema v15 zones', () => {
  it('migrate creates zones/zone_members tables and units.zone_id with index', () => {
    const db = migratedDb('schema.db');
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('zones');
    expect(tables).toContain('zone_members');
    const cols = db
      .prepare(`PRAGMA table_info(units)`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('zone_id');
    const idx = db
      .prepare(`PRAGMA index_list(units)`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(idx).toContain('idx_units_zone');
    db.close();
  });

  it('seeds inbox + shared zones for the built-in default workspace', () => {
    const db = migratedDb('seed-default.db');
    seedDefaultZones(db);
    const zones = db
      .prepare('SELECT id, kind, visibility FROM zones WHERE workspace_id = ?')
      .all('ws_personal') as Array<{ id: string; kind: string; visibility: string }>;
    const byKind = Object.fromEntries(zones.map((z) => [z.kind, z]));
    expect(byKind.inbox).toEqual({ id: 'z_inbox_ws_personal', kind: 'inbox', visibility: 'workspace' });
    expect(byKind.shared).toEqual({ id: 'z_shared_ws_personal', kind: 'shared', visibility: 'workspace' });
    db.close();
  });

  it('seeds per-member personal zones in every workspace and is idempotent', () => {
    const db = migratedDb('multi.db');
    addWorkspace(db, 'ws_a', 'acme', 'Acme', 'u1');
    addMember(db, 'ws_a', 'u2', 'member');
    addWorkspace(db, 'ws_b', 'beta', 'Beta', 'u3');
    addMember(db, 'ws_b', 'u1', 'member');
    seedDefaultZones(db);
    seedDefaultZones(db);

    const count = db.prepare('SELECT COUNT(*) AS n FROM zones').get() as { n: number };
    expect(count.n).toBe(10); // 4 (ws_a) + 4 (ws_b) + 2 (built-in ws_personal)
    const personal = db
      .prepare(
        `SELECT id, workspace_id, owner_user_id FROM zones
         WHERE kind = 'personal' AND workspace_id IN ('ws_a', 'ws_b') ORDER BY id`,
      )
      .all() as Array<{ id: string; workspace_id: string; owner_user_id: string }>;
    expect(personal).toEqual([
      { id: 'z_personal_u1_ws_a', workspace_id: 'ws_a', owner_user_id: 'u1' },
      { id: 'z_personal_u1_ws_b', workspace_id: 'ws_b', owner_user_id: 'u1' },
      { id: 'z_personal_u2_ws_a', workspace_id: 'ws_a', owner_user_id: 'u2' },
      { id: 'z_personal_u3_ws_b', workspace_id: 'ws_b', owner_user_id: 'u3' },
    ]);
    const members = db
      .prepare('SELECT zone_id, user_id, role FROM zone_members ORDER BY zone_id, user_id')
      .all() as Array<{ zone_id: string; user_id: string; role: string }>;
    expect(members).toHaveLength(4);
    expect(members[0]).toEqual({ zone_id: 'z_personal_u1_ws_a', user_id: 'u1', role: 'owner' });
    db.close();
  });

  it('backfills dangling unit zone_id values to the workspace inbox zone', () => {
    const db = migratedDb('backfill.db');
    addWorkspace(db, 'ws_a', 'acme', 'Acme', 'u1');
    const insert = db.prepare(
      `INSERT INTO units (id, type, form, title, summary, body, status, workspace_id, zone_id, created_at, updated_at)
       VALUES (?, 'fact', 'unit', ?, '', '', 'reviewed', ?, ?, ?, ?)`,
    );
    insert.run('u1', 'Legacy inbox literal', 'ws_a', 'z_inbox', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    insert.run('u2', 'Bogus zone id', 'ws_a', 'z_nope', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    seedDefaultZones(db);
    const rows = db.prepare('SELECT id, zone_id FROM units ORDER BY id').all() as Array<{ id: string; zone_id: string }>;
    expect(rows).toEqual([
      { id: 'u1', zone_id: 'z_inbox_ws_a' },
      { id: 'u2', zone_id: 'z_inbox_ws_a' },
    ]);
    db.close();
  });

  it('createSqliteStorageFromPath seeds default zones automatically', async () => {
    const path = tmpDb('auto.db');
    const storage = await createSqliteStorageFromPath(path);
    await storage.close();
    const db = new Database(path);
    const zones = db.prepare('SELECT id FROM zones').all() as Array<{ id: string }>;
    expect(zones.some((z) => z.id === 'z_inbox_ws_personal')).toBe(true);
    expect(zones.some((z) => z.id === 'z_shared_ws_personal')).toBe(true);
    db.close();
  });
});

describe('zone storage methods', () => {
  it('zone CRUD round-trips through SqliteStorage', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('crud.db'));
    const created = await storage.createZone({
      workspaceId: 'ws_personal',
      slug: 'backend',
      name: 'Backend',
      kind: 'project',
      visibility: 'members',
      description: 'Backend engineering notes',
      auto: true,
    });
    expect(created.id).toMatch(/^z_/);
    expect(created.workspaceId).toBe('ws_personal');
    expect(created.auto).toBe(true);

    const got = await storage.getZone(created.id);
    expect(got).toEqual(created);
    const listed = await storage.listZones();
    expect(listed.some((z) => z.id === created.id)).toBe(true);

    await storage.updateZone({ ...created, name: 'Backend v2', visibility: 'workspace' });
    const updated = await storage.getZone(created.id);
    expect(updated!.name).toBe('Backend v2');
    expect(updated!.visibility).toBe('workspace');

    await storage.deleteZone(created.id);
    expect(await storage.getZone(created.id)).toBeNull();
    await storage.close();
  });

  it('zone members can be added, listed and removed', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('members.db'));
    const zone = await storage.createZone({ workspaceId: 'ws_personal', slug: 'team', name: 'Team', kind: 'project' });
    await storage.addZoneMember(zone.id, 'u1', 'owner');
    await storage.addZoneMember(zone.id, 'u2', 'reader');
    const members = await storage.listZoneMembers(zone.id);
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.userId === 'u1')!.role).toBe('owner');
    await storage.removeZoneMember(zone.id, 'u2');
    const after = await storage.listZoneMembers(zone.id);
    expect(after.map((m) => m.userId)).toEqual(['u1']);
    await storage.close();
  });

  it('moveUnitZone relocates a unit and rejects unknown zones', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('move.db'));
    const unitObj = {
      id: 'u-move', type: 'fact' as const, form: 'unit' as const, title: 'T', summary: 's', body: 'b',
      tags: [], labels: {}, status: 'reviewed' as const, quality: 0.8, confidence: 0.7,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      sourceCount: 0, importance: 0.5, decay: 1, version: 1,
    };
    await storage.createUnit(unitObj);
    const zone = await storage.createZone({ workspaceId: 'ws_personal', slug: 'proj', name: 'Proj', kind: 'project' });
    await storage.moveUnitZone('u-move', zone.id);
    const moved = await storage.getUnit('u-move');
    expect(moved!.zoneId).toBe(zone.id);
    await expect(storage.moveUnitZone('u-move', 'z_does_not_exist')).rejects.toThrow(/not found/);
    await storage.close();
  });

  it('createUnit persists an explicit zoneId and defaults new units to the inbox', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('persist.db'));
    const zone = await storage.createZone({ workspaceId: 'ws_personal', slug: 'docs', name: 'Docs', kind: 'project' });
    const explicit = {
      id: 'u-z', type: 'fact' as const, form: 'unit' as const, title: 'Zoned', summary: 's', body: 'b',
      tags: [], labels: {}, status: 'reviewed' as const, quality: 0.8, confidence: 0.7,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      sourceCount: 0, importance: 0.5, decay: 1, version: 1, zoneId: zone.id,
    };
    await storage.createUnit(explicit);
    expect((await storage.getUnit('u-z'))!.zoneId).toBe(zone.id);

    const plain = { ...explicit, id: 'u-plain', zoneId: undefined };
    await storage.createUnit(plain);
    expect((await storage.getUnit('u-plain'))!.zoneId).toBe('z_inbox_ws_personal');
    await storage.close();
  });
});

describe('zone-scoped request context (storage-layer ACL)', () => {
  const ctxWs = {
    workspaceId: 'ws_a',
    workspaceSlug: 'a',
    scopes: ['read', 'write', 'admin'],
    realm: 'user' as const,
    authEnabled: true,
  };
  const ctxU1 = {
    ...ctxWs,
    userId: 'u1',
    zoneIds: ['z_personal_u1_ws_a', 'z_shared_ws_a', 'z_inbox_ws_a'],
  };
  const ctxU2 = {
    ...ctxWs,
    userId: 'u2',
    zoneIds: ['z_personal_u2_ws_a', 'z_shared_ws_a', 'z_inbox_ws_a'],
  };

  /** Storage with a workspace ws_a that has members u1 (owner) and u2, and
   *  deterministic seeded zones (z_inbox/z_shared/z_personal_*). */
  async function storageWithWorkspace(name: string): Promise<Awaited<ReturnType<typeof createSqliteStorageFromPath>>> {
    const path = tmpDb(name);
    const storage = await createSqliteStorageFromPath(path);
    const db = new Database(path);
    addWorkspace(db, 'ws_a', 'acme', 'Acme', 'u1');
    addMember(db, 'ws_a', 'u2', 'member');
    seedDefaultZones(db);
    db.close();
    return storage;
  }

  function unit(over: { id: string; title: string; zoneId: string }): Unit {
    return {
      id: over.id,
      type: 'fact' as const,
      form: 'unit' as const,
      title: over.title,
      summary: 's',
      body: 'b',
      tags: [],
      labels: {},
      status: 'reviewed' as const,
      quality: 0.8,
      confidence: 0.7,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sourceCount: 0,
      importance: 0.5,
      decay: 1,
      version: 1,
      zoneId: over.zoneId,
    };
  }

  it('listUnits only returns units in accessible zones; legacy context sees all', async () => {
    const storage = await storageWithWorkspace('acl-units.db');
    await runWithRequestContextAsync(ctxWs, async () => {
      await storage.createUnit(unit({ id: 'u1p', title: 'U1 private', zoneId: 'z_personal_u1_ws_a' }));
      await storage.createUnit(unit({ id: 'u2p', title: 'U2 private', zoneId: 'z_personal_u2_ws_a' }));
      await storage.createUnit(unit({ id: 'ush', title: 'Shared', zoneId: 'z_shared_ws_a' }));
      await storage.createUnit(unit({ id: 'uin', title: 'Inbox', zoneId: 'z_inbox_ws_a' }));
    });

    const titles = async (ctx: typeof ctxU1) =>
      runWithRequestContextAsync(ctx, async () => {
        const units = await storage.listUnits({});
        return units.map((u) => u.title).sort();
      });

    expect(await titles(ctxU1)).toEqual(['Inbox', 'Shared', 'U1 private']);
    expect(await titles(ctxU2)).toEqual(['Inbox', 'Shared', 'U2 private']);
    // Legacy (no zoneIds) sees everything in the workspace.
    expect(await titles(ctxWs)).toEqual(['Inbox', 'Shared', 'U1 private', 'U2 private']);
    await storage.close();
  });

  it('getUnit returns null for units outside the accessible zones', async () => {
    const storage = await storageWithWorkspace('acl-get.db');
    await runWithRequestContextAsync(ctxWs, async () => {
      await storage.createUnit(unit({ id: 'u1p', title: 'U1 private', zoneId: 'z_personal_u1_ws_a' }));
      await storage.createUnit(unit({ id: 'u2p', title: 'U2 private', zoneId: 'z_personal_u2_ws_a' }));
    });

    await runWithRequestContextAsync(ctxU1, async () => {
      expect((await storage.getUnit('u1p'))?.title).toBe('U1 private');
      expect(await storage.getUnit('u2p')).toBeNull();
    });
    await runWithRequestContextAsync(ctxU2, async () => {
      expect(await storage.getUnit('u1p')).toBeNull();
      expect((await storage.getUnit('u2p'))?.title).toBe('U2 private');
    });
    await storage.close();
  });

  it('links: visible when at least one endpoint unit is in an accessible zone', async () => {
    const storage = await storageWithWorkspace('acl-links.db');
    await runWithRequestContextAsync(ctxWs, async () => {
      await storage.createUnit(unit({ id: 'uA', title: 'A shared', zoneId: 'z_shared_ws_a' }));
      await storage.createUnit(unit({ id: 'uB', title: 'B u1', zoneId: 'z_personal_u1_ws_a' }));
      await storage.createUnit(unit({ id: 'uB2', title: 'B2 u1', zoneId: 'z_personal_u1_ws_a' }));
      await storage.createUnit(unit({ id: 'uC', title: 'C u2', zoneId: 'z_personal_u2_ws_a' }));
      await storage.createUnit(unit({ id: 'uD', title: 'D u2', zoneId: 'z_personal_u2_ws_a' }));
      const link = (id: string, sourceUnitId: string, targetUnitId: string) => ({
        id,
        sourceUnitId,
        targetUnitId,
        relation: 'related',
        reason: 'test',
        confidence: 0.9,
        auto: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await storage.createLink(link('l1', 'uA', 'uB'));
      await storage.createLink(link('l2', 'uA', 'uC'));
      await storage.createLink(link('l3', 'uB', 'uC'));
      await storage.createLink(link('l5', 'uC', 'uD'));
      await storage.createLink(link('l6', 'uB', 'uB2'));
    });

    await runWithRequestContextAsync(ctxU1, async () => {
      const links = await storage.allLinks();
      expect(links.map((l) => l.id).sort()).toEqual(['l1', 'l2', 'l3', 'l6']);
      // Both endpoints live in u2's private zone -> invisible to u1.
      expect(links.some((l) => l.id === 'l5')).toBe(false);
      const forB = await storage.getLinksForUnit('uB');
      expect(forB.map((l) => l.id).sort()).toEqual(['l1', 'l3', 'l6']);
    });
    await runWithRequestContextAsync(ctxU2, async () => {
      const links = await storage.allLinks();
      expect(links.map((l) => l.id).sort()).toEqual(['l1', 'l2', 'l3', 'l5']);
      // Both endpoints live in u1's private zone -> invisible to u2.
      expect(links.some((l) => l.id === 'l6')).toBe(false);
    });
    await storage.close();
  });

  it('scenarios/assets are filtered by the zones of their source units', async () => {
    const storage = await storageWithWorkspace('acl-refs.db');
    await runWithRequestContextAsync(ctxWs, async () => {
      await storage.createUnit(unit({ id: 'uB', title: 'B u1', zoneId: 'z_personal_u1_ws_a' }));
      await storage.createUnit(unit({ id: 'uC', title: 'C u2', zoneId: 'z_personal_u2_ws_a' }));
      await storage.createUnit(unit({ id: 'uA', title: 'A shared', zoneId: 'z_shared_ws_a' }));
      const scenario = (id: string, sourceUnitIds: string[]) => ({
        id,
        title: id,
        summary: 's',
        content: 'c',
        tags: [],
        sourceUnitIds,
        status: 'active' as const,
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await storage.createScenario(scenario('s1', ['uB']));
      await storage.createScenario(scenario('s2', ['uA']));
      const asset = (id: string, sourceUnitIds: string[]) => ({
        id,
        kind: 'skill' as const,
        name: id,
        description: 'd',
        content: '{}',
        body: 'b',
        trigger: 't',
        tags: [],
        sourceUnitIds,
        status: 'published' as const,
        visibility: 'workspace' as const,
        boundAgents: [],
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await storage.createAsset(asset('a1', ['uB']));
      await storage.createAsset(asset('a2', ['uA']));
    });

    await runWithRequestContextAsync(ctxU1, async () => {
      expect((await storage.listScenarios({})).map((s) => s.id).sort()).toEqual(['s1', 's2']);
      expect((await storage.listAssets({})).map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    });
    await runWithRequestContextAsync(ctxU2, async () => {
      expect((await storage.listScenarios({})).map((s) => s.id)).toEqual(['s2']);
      expect(await storage.getScenario('s1')).toBeNull();
      expect((await storage.listAssets({})).map((a) => a.id)).toEqual(['a2']);
      expect(await storage.getAsset('a1')).toBeNull();
      const equipped = await storage.listEquipped('any-agent');
      expect(equipped.map((a) => a.id)).toEqual(['a2']);
    });
    await storage.close();
  });

  it('write guards reject updates/moves/deletes of units in inaccessible zones', async () => {
    const storage = await storageWithWorkspace('acl-write.db');
    await runWithRequestContextAsync(ctxWs, async () => {
      await storage.createUnit(unit({ id: 'u1p', title: 'U1 private', zoneId: 'z_personal_u1_ws_a' }));
      await storage.createUnit(unit({ id: 'u2p', title: 'U2 private', zoneId: 'z_personal_u2_ws_a' }));
    });

    await runWithRequestContextAsync(ctxU1, async () => {
      const u2 = await storage.getUnit('u2p');
      expect(u2).toBeNull(); // read is already blocked
      // Direct write attempts are rejected by the storage guard.
      const u2Direct = { ...unit({ id: 'u2p', title: 'Hacked', zoneId: 'z_personal_u2_ws_a' }) };
      await expect(storage.updateUnit(u2Direct)).rejects.toThrow(/not accessible/);
      await expect(storage.deleteUnit('u2p')).rejects.toThrow(/not accessible/);
      await expect(storage.moveUnitZone('u2p', 'z_shared_ws_a')).rejects.toThrow(/not accessible/);
      // Own-zone writes still work.
      const u1 = (await storage.getUnit('u1p'))!;
      await storage.updateUnit({ ...u1, title: 'U1 renamed' });
      expect((await storage.getUnit('u1p'))!.title).toBe('U1 renamed');
    });
    await storage.close();
  });
});
