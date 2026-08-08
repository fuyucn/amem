import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Asset, Link, Source, Storage, Unit } from '@amem/core';
import { runWithRequestContextAsync } from '@amem/core';
import { createSqliteStorageFromPath } from '../src/index.js';

const dirs: string[] = [];
function tmpDb(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'amem-dbtest-'));
  dirs.push(d);
  return join(d, name);
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function unit(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u1', type: 'fact', form: 'unit', title: 'Sample', summary: 'summary', body: 'body',
    tags: ['a'], labels: { n: 1 }, status: 'reviewed', quality: 0.8, confidence: 0.7,
    embedding: { dims: 2, values: [0.6, 0.8] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    sourceCount: 0, importance: 0.5, decay: 1, version: 1,
    ...over,
  };
}

describe('SqliteStorage', () => {
  it('database migrations are idempotent', () => {
    const db = tmpDb('mig.db');
    // Create via storage factory (runs migrate), then run migrate again.
    return createSqliteStorageFromPath(db).then(async (storage) => {
      await storage.close();
      // Reopening runs migrate again; should not throw.
      const s2 = await createSqliteStorageFromPath(db);
      await s2.close();
    });
  });

  it('unit CRUD and listUnits filters', async () => {
    const storage: Storage = await createSqliteStorageFromPath(tmpDb('crud.db'));
    await storage.createUnit(unit());
    await storage.createUnit(unit({ id: 'u2', type: 'decision', tags: ['b'], title: 'Dec' }));
    const all = await storage.listUnits({});
    expect(all.length).toBe(2);
    const facts = await storage.listUnits({ type: 'fact' });
    expect(facts.length).toBe(1);
    const tagged = await storage.listUnits({ tag: 'b' });
    expect(tagged.length).toBe(1);
    const got = await storage.getUnit('u1');
    expect(got).not.toBeNull();
    expect(got!.title).toBe('Sample');
    const missing = await storage.getUnit('nope');
    expect(missing).toBeNull();
    // update
    const updated = { ...(await storage.getUnit('u1'))!, title: 'Renamed' };
    await storage.updateUnit(updated);
    expect((await storage.getUnit('u1'))!.title).toBe('Renamed');
    await storage.deleteUnit('u2');
    expect((await storage.listUnits({})).length).toBe(1);
    await storage.close();
  });

  it('embedding round-trips', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('emb.db'));
    await storage.createUnit(unit({ embedding: { dims: 3, values: [0.1, 0.2, 0.3] } }));
    const all = await storage.allUnitsWithEmbeddings();
    expect(all[0]!.embedding!.values).toEqual([0.1, 0.2, 0.3]);
    await storage.close();
  });

  it('links: create, upsert, get, all, unique', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('link.db'));
    await storage.createUnit(unit());
    await storage.createUnit(unit({ id: 'u2' }));
    const l: Link = { id: 'L1', sourceUnitId: 'u1', targetUnitId: 'u2', relation: 'related_to', reason: 'r', confidence: 0.8, auto: true, createdAt: '2026-01-01T00:00:00.000Z' };
    await storage.createLink(l);
    expect((await storage.allLinks()).length).toBe(1);
    // second link with same key -> replaced by upsert (kept as 1 distinct if same id; if new id, uniques on triple may throw)
    await storage.upsertLink({ ...l, id: 'L2' });
    expect((await storage.allLinks()).length).toBe(1);
    expect((await storage.getLinksForUnit('u1')).length).toBe(1);
    const cur = await storage.allLinks();
    await storage.deleteLink(cur[0]!.id);
    expect((await storage.allLinks()).length).toBe(0);
    await storage.close();
  });

  it('sources + citations + distinctSourceIds', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('cite.db'));
    await storage.createUnit(unit());
    for (const id of ['s1', 's2', 's3']) {
      const s: Source = { id, title: `src ${id}`, kind: 'manual', contentHash: 'h', contentLength: 1, createdAt: '2026-01-01T00:00:00.000Z' };
      await storage.upsertSource(s);
    }
    for (const sid of ['s1', 's2', 's3']) {
      await storage.addCitation({ unitId: 'u1', sourceId: sid, assertedAt: '2026-01-01T00:00:00.000Z' });
    }
    const distinct = await storage.distinctSourceIdsForUnit('u1');
    expect(distinct.sort()).toEqual(['s1', 's2', 's3']);
    const cites = await storage.getCitationsForUnit('u1');
    expect(cites.length).toBe(3);
    const byIds = await storage.sourcesByIds(['s1', 's3']);
    expect(byIds.length).toBe(2);
    await storage.close();
  });

  it('versions list', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('ver.db'));
    await storage.createUnit(unit());
    const v1 = { id: 'v1', unitId: 'u1', version: 1, snapshot: { ...unit(), embedding: undefined }, reason: 'create', createdAt: '2026-01-01T00:00:00.000Z' };
    const v2 = { ...v1, id: 'v2', version: 2 };
    await storage.createVersion(v1);
    await storage.createVersion(v2);
    const versions = await storage.listVersions('u1');
    expect(versions.length).toBe(2);
    expect(versions[1]!.version).toBe(2);
    await storage.close();
  });

  it('counts / byType / perDay', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('stats.db'));
    await storage.createUnit(unit());
    await storage.createUnit(unit({ id: 'u2', type: 'decision', form: 'crystal' }));
    await storage.createUnit(unit({ id: 'u3', status: 'pending' }));
    await storage.createTrace({ id: 't1', title: 'T', content: 'x', contentType: 'text', tokenCount: 10, createdAt: '2026-01-02T00:00:00.000Z' });
    const counts = await storage.counts();
    expect(counts.units).toBe(3);
    expect(counts.crystals).toBe(1);
    expect(counts.traces).toBe(1);
    expect(counts.pendingReview).toBe(1);
    const byType = await storage.byTypeCounts();
    expect(byType.fact).toBe(2);
    expect(byType.decision).toBe(1);
    const perDay = await storage.perDay(10);
    expect(Array.isArray(perDay)).toBe(true);
    await storage.close();
  });

  it('transactions roll back on error', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('tx.db'));
    await expect(
      storage.transaction(async () => {
        await storage.createUnit(unit());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await storage.listUnits({})).length).toBe(0);
    await storage.close();
  });

  it('jobs record/mark', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('job.db'));
    const id = await storage.recordJob({ kind: 'consolidate', status: 'running' });
    await storage.markJob(id, 'done');
    await storage.close();
  });


  it('records and lists activity events', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('events.db'));
    await storage.recordEvent({ kind: 'ingest', summary: 'Ingested hello', actor: 'test', meta: { unitIds: ['u1'] } });
    await storage.recordEvent({ kind: 'recall', summary: 'Recalled 1 unit', meta: { query: 'hello' } });
    const all = await storage.listEvents({ limit: 10 });
    expect(all.length).toBe(2);
    expect(all.map((e) => e.kind).sort()).toEqual(['ingest', 'recall']);
    const onlyIngest = await storage.listEvents({ kind: 'ingest' });
    expect(onlyIngest.length).toBe(1);
    expect(onlyIngest[0]!.summary).toContain('hello');
    await storage.close();
  });

  it('ai_providers: CRUD, activation, and encrypted key roundtrip', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('prov.db'), 'test-secret-16-chars');
    // Create
    const p = await storage.upsertProvider({
      id: 'prov_1',
      name: 'DeepSeek',
      kind: 'openai_compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-test-123456',
      isActive: false,
    });
    expect(p.apiKey).toBe('sk-test-123456');
    expect(p.isActive).toBe(false);

    // Activate and verify singleton semantics
    await storage.setActiveProvider('prov_1');
    const active = await storage.getActiveProvider();
    expect(active?.id).toBe('prov_1');
    expect(active?.apiKey).toBe('sk-test-123456');

    // Second provider takes over active flag
    await storage.upsertProvider({
      id: 'prov_2',
      name: 'Local',
      kind: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3',
    });
    await storage.setActiveProvider('prov_2');
    expect((await storage.getActiveProvider())?.id).toBe('prov_2');
    const list = await storage.listProviders();
    expect(list.length).toBe(2);
    expect(list.find((x) => x.id === 'prov_1')?.isActive).toBe(false);

    // Key is encrypted at rest (raw key must not appear in the row)
    const raw = (storage as unknown as { db: import('better-sqlite3').Database }).db
      .prepare('SELECT api_key FROM ai_providers WHERE id = ?')
      .get('prov_1') as { api_key: string };
    expect(raw.api_key).not.toContain('sk-test-123456');
    expect(raw.api_key.startsWith('enc:v1:')).toBe(true);

    // Update without apiKey preserves the stored key
    await storage.upsertProvider({
      id: 'prov_1',
      name: 'DeepSeek Updated',
      kind: 'openai_compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-reasoner',
    });
    const updated = (await storage.listProviders()).find((x) => x.id === 'prov_1')!;
    expect(updated.name).toBe('DeepSeek Updated');
    expect(updated.apiKey).toBe('sk-test-123456');

    await storage.deleteProvider('prov_2');
    expect((await storage.listProviders()).length).toBe(1);
    await storage.close();
  });

  it('ai_providers: key stays undecryptable when secret changes', async () => {
    const db = tmpDb('prov-secret.db');
    const s1 = await createSqliteStorageFromPath(db, 'secret-one-16chars');
    await s1.upsertProvider({
      id: 'prov_1',
      name: 'X',
      kind: 'openai_compatible',
      baseUrl: 'https://x.example/v1',
      model: 'm',
      apiKey: 'sk-rotate-me',
    });
    await s1.close();
    const s2 = await createSqliteStorageFromPath(db, 'secret-two-16chars');
    const p = (await s2.listProviders())[0]!;
    expect(p.apiKey).toBeUndefined();
    await s2.close();
  });

  it('L2 scenarios: CRUD + tag filter', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('scn.db'));
    await storage.createScenario({
      id: 'scn_1', title: 'MCP onboarding', summary: 'How agents onboard',
      content: '# MCP onboarding\nSteps...', tags: ['mcp', 'codex'], sourceUnitIds: ['u1'],
      status: 'active', version: 1, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    await storage.createScenario({
      id: 'scn_2', title: 'Auth flow', summary: 'OAuth flow notes',
      content: '# Auth\nPKCE...', tags: ['auth'], sourceUnitIds: [],
      status: 'active', version: 1, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    const all = await storage.listScenarios({});
    expect(all.length).toBe(2);
    expect(all[0]!.id).toBe('scn_2'); // newest first
    const tagged = await storage.listScenarios({ tag: 'mcp' });
    expect(tagged.length).toBe(1);
    expect(tagged[0]!.id).toBe('scn_1');
    expect(await storage.getScenario('scn_1')).not.toBeNull();
    expect(await storage.getScenario('nope')).toBeNull();

    const got = (await storage.getScenario('scn_1'))!;
    await storage.updateScenario({ ...got, title: 'MCP onboarding v2', version: 2 });
    expect((await storage.getScenario('scn_1'))!.title).toBe('MCP onboarding v2');

    await storage.deleteScenario('scn_2');
    expect((await storage.listScenarios({})).length).toBe(1);
    await storage.close();
  });

  it('L3 persona: upsert keeps one persona per workspace', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('per.db'));
    await storage.upsertPersona({
      id: 'pers_1', content: 'Prefers concise codex-style answers', version: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect((await storage.getPersona())!.content).toContain('concise');

    // Second upsert updates the same row (version bumps), no duplicates.
    await storage.upsertPersona({
      id: 'pers_2', content: 'Prefers concise answers, works in 25-min sprints', version: 2,
      createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const persona = (await storage.getPersona())!;
    expect(persona.content).toContain('25-min sprints');
    expect(persona.version).toBe(2);
    await storage.close();
  });

  it('assets: CRUD + kind/status filters', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('ast.db'));
    const base = {
      description: 'd', content: '{"steps":[]}', body: 'Steps...', trigger: 'when X',
      tags: ['codex'], sourceUnitIds: ['u1'], status: 'draft' as const,
      version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await storage.createAsset({ id: 'ast_1', kind: 'skill', name: 'Deploy amem', ...base });
    await storage.createAsset({
      id: 'ast_2', kind: 'wiki', name: 'Amem wiki', ...base, status: 'published',
    });

    expect((await storage.listAssets({})).length).toBe(2);
    const skills = await storage.listAssets({ kind: 'skill' });
    expect(skills.length).toBe(1);
    expect(skills[0]!.id).toBe('ast_1');
    expect((await storage.listAssets({ status: 'published' })).length).toBe(1);
    expect((await storage.getAsset('ast_2'))!.name).toBe('Amem wiki');
    expect(await storage.getAsset('nope')).toBeNull();

    const got = (await storage.getAsset('ast_1'))!;
    await storage.updateAsset({ ...got, status: 'published', version: 2 });
    expect((await storage.getAsset('ast_1'))!.status).toBe('published');

    await storage.deleteAsset('ast_2');
    expect((await storage.listAssets({})).length).toBe(1);
    await storage.close();
  });

  it('assets: version chain snapshots previous content and lists newest-first', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('astv.db'));
    const base = {
      description: 'd', content: '{"steps":[]}', body: 'Steps...', trigger: 'when X',
      tags: ['codex'], sourceUnitIds: ['u1'], status: 'draft' as const,
      version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const v1: Asset = { id: 'ast_v', kind: 'skill', name: 'Deploy amem', ...base };
    await storage.createAsset(v1);
    await storage.snapshotAssetVersion(v1, 'skill-extract: content changed');
    const v2: Asset = {
      ...v1,
      content: '{"steps":["new"]}',
      body: '# Deploy amem\n\nnew steps',
      version: 2,
      updatedAt: '2026-01-03T00:00:00.000Z',
    };
    await storage.updateAsset(v2);

    const versions = await storage.listAssetVersions('ast_v');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.reason).toContain('content changed');
    expect((versions[0]!.snapshot as Asset).body).toBe('Steps...');
    expect((versions[0]!.snapshot as Asset).id).toBeUndefined();
    expect(await storage.listAssetVersions('nope')).toEqual([]);

    // Deleting the asset removes its version chain too (FK would otherwise block).
    await storage.deleteAsset('ast_v');
    expect(await storage.getAsset('ast_v')).toBeNull();
    expect(await storage.listAssetVersions('ast_v')).toEqual([]);
    await storage.close();
  });

  it('assets: listEquipped filters by visibility + agent binding', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('eq.db'));
    const base = {
      description: 'd', content: '{"steps":[]}', body: 'Steps...', trigger: 'when X',
      tags: ['codex'], sourceUnitIds: ['u1'], version: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    // published + workspace visibility -> equipped for any agent
    await storage.createAsset({ id: 'ast_ws', kind: 'skill', name: 'WS skill', ...base, status: 'published', visibility: 'workspace' });
    // published + public -> equipped
    await storage.createAsset({ id: 'ast_pub', kind: 'wiki', name: 'Public wiki', ...base, status: 'published', visibility: 'public' });
    // published + explicitly bound to 'codex'
    await storage.createAsset({ id: 'ast_bind', kind: 'skill', name: 'Bound skill', ...base, status: 'published', visibility: 'private', boundAgents: ['codex'] });
    // published + private, no binding -> excluded
    await storage.createAsset({ id: 'ast_priv', kind: 'skill', name: 'Private skill', ...base, status: 'published', visibility: 'private' });
    // draft + bound -> excluded (not published)
    await storage.createAsset({ id: 'ast_draft', kind: 'skill', name: 'Draft skill', ...base, status: 'draft', visibility: 'public', boundAgents: ['codex'] });
    // bound to a different agent -> excluded for codex
    await storage.createAsset({ id: 'ast_other', kind: 'skill', name: 'Other agent', ...base, status: 'published', visibility: 'private', boundAgents: ['claude'] });

    const forCodex = (await storage.listEquipped('codex')).map((a) => a.id).sort();
    expect(forCodex).toEqual(['ast_bind', 'ast_pub', 'ast_ws']);

    const forClaude = (await storage.listEquipped('claude')).map((a) => a.id).sort();
    expect(forClaude).toEqual(['ast_other', 'ast_pub', 'ast_ws']);
    await storage.close();
  });

  it('L2 scenarios: heat round-trip, heat sort, and bump', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('scn-heat.db'));
    await storage.createScenario({
      id: 'scn_hot', title: 'Hot scene', summary: 'frequently recalled',
      content: 'hot content', tags: ['scene'], sourceUnitIds: [],
      status: 'active', version: 1, heat: 7, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await storage.createScenario({
      id: 'scn_cold', title: 'Cold scene', summary: 'rarely touched',
      content: 'cold content', tags: ['scene'], sourceUnitIds: [],
      status: 'active', version: 1, createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const byHeat = await storage.listScenarios({ sort: 'heat' });
    expect(byHeat.map((s) => s.id)).toEqual(['scn_hot', 'scn_cold']);
    expect(byHeat[1]!.heat).toBe(0);

    await storage.bumpScenarioHeat('scn_cold');
    const bumped = (await storage.getScenario('scn_cold'))!;
    expect(bumped.heat).toBe(1);
    expect(bumped.lastHitAt).toBeTruthy();

    await storage.updateScenario({
      ...(await storage.getScenario('scn_hot'))!,
      heat: 42,
      lastHitAt: '2026-02-01T00:00:00.000Z',
    });
    const updated = (await storage.getScenario('scn_hot'))!;
    expect(updated.heat).toBe(42);
    expect(updated.lastHitAt).toBe('2026-02-01T00:00:00.000Z');
    await storage.close();
  });

  it('workspace isolation: scenarios/personas/assets do not leak across workspaces', async () => {
    const storage = await createSqliteStorageFromPath(tmpDb('iso.db'));
    const ctxA = {
      workspaceId: 'ws_a', workspaceSlug: 'a', scopes: ['read', 'write', 'admin'],
      realm: 'user' as const, authEnabled: true,
    };
    const ctxB = {
      workspaceId: 'ws_b', workspaceSlug: 'b', scopes: ['read', 'write', 'admin'],
      realm: 'user' as const, authEnabled: true,
    };

    await runWithRequestContextAsync(ctxA, async () => {
      await storage.createScenario({
        id: 'scn_a', title: 'A secret scenario', summary: 's', content: 'c', tags: [],
        sourceUnitIds: [], status: 'active', version: 1,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await storage.upsertPersona({
        id: 'pers_a', content: 'A persona', version: 1,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await storage.createAsset({
        id: 'ast_a', kind: 'skill', name: 'A skill', description: 'd', content: '{}',
        body: 'b', trigger: 't', tags: [], sourceUnitIds: [], status: 'draft', version: 1,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    // Workspace B sees none of A's data, and can write its own.
    await runWithRequestContextAsync(ctxB, async () => {
      expect(await storage.listScenarios({})).toEqual([]);
      expect(await storage.getScenario('scn_a')).toBeNull();
      expect(await storage.getPersona()).toBeNull();
      expect(await storage.listAssets({})).toEqual([]);
      expect(await storage.getAsset('ast_a')).toBeNull();

      await storage.createScenario({
        id: 'scn_b', title: 'B scenario', summary: 's', content: 'c', tags: [],
        sourceUnitIds: [], status: 'active', version: 1,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
      expect((await storage.listScenarios({})).length).toBe(1);
    });

    // And A still sees its own row, not B's.
    await runWithRequestContextAsync(ctxA, async () => {
      expect((await storage.listScenarios({})).length).toBe(1);
      expect((await storage.getScenario('scn_a'))!.title).toBe('A secret scenario');
      expect(await storage.getScenario('scn_b')).toBeNull();
    });
    await storage.close();
  });

});
