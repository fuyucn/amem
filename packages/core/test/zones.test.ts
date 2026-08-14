import { describe, expect, it } from 'vitest';
import {
  LLM_ZONE_ASSIGN_INTENT,
  MockLlmClient,
  OfflineEmbedder,
  createService,
  getZoneAccess,
  recall,
  proposeNewZones,
  recomputeZoneCentroids,
  resolveZoneForWrite,
  runWithRequestContext,
  mergeConfig,
  type AmemConfig,
  type Embedder,
  type NewUnit,
  type Zone,
} from '../src/index.js';
import { FakeStorage, makeUnit } from './helpers.js';

function testConfig(): AmemConfig {
  return mergeConfig({
    workspace: { defaultId: 'ws_1', defaultSlug: 'ws1' },
    embedding: { mode: 'offline', dims: 8 },
    llm: { baseUrl: '', model: '', apiKey: '' },
    jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 },
  });
}

/** Deterministic API-mode embedder with a per-text lookup table. */
class TableEmbedder implements Embedder {
  readonly mode = 'api';
  constructor(
    private readonly table: Map<string, number[]>,
    private readonly dims = 8,
  ) {}
  async embed(text: string): Promise<number[]> {
    return this.table.get(text) ?? new Array(this.dims).fill(0);
  }
  async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.table.get(t) ?? new Array(this.dims).fill(0));
  }
  async dims(): Promise<number> {
    return this.dims;
  }
}

const V_A = [1, 0, 0, 0, 0, 0, 0, 0];
const V_B = [0, 1, 0, 0, 0, 0, 0, 0];

async function seededZones(storage: FakeStorage): Promise<{
  inbox: Zone;
  shared: Zone;
  personal: Zone;
  project: Zone;
}> {
  const inbox = await storage.createZone({
    workspaceId: 'ws_1',
    slug: 'inbox',
    name: 'Inbox',
    kind: 'inbox',
    visibility: 'workspace',
  });
  const shared = await storage.createZone({
    workspaceId: 'ws_1',
    slug: 'shared',
    name: 'Shared',
    kind: 'shared',
    visibility: 'workspace',
  });
  const personal = await storage.createZone({
    workspaceId: 'ws_1',
    slug: 'personal-alice',
    name: 'Personal',
    kind: 'personal',
    visibility: 'private',
    ownerUserId: 'alice',
  });
  const project = await storage.createZone({
    workspaceId: 'ws_1',
    slug: 'infra',
    name: 'Infra',
    kind: 'project',
    visibility: 'members',
  });
  return { inbox, shared, personal, project };
}

function newUnit(over: Partial<NewUnit> = {}): NewUnit {
  const base = makeUnit();
  const { ...rest } = base;
  return { ...rest, ...over };
}

describe('getZoneAccess', () => {
  it('returns personal own + workspace-visible + explicit memberships', async () => {
    const storage = new FakeStorage();
    const { inbox, shared, personal, project } = await seededZones(storage);
    await storage.addZoneMember(project.id, 'alice', 'editor');

    const alice = await getZoneAccess(storage, 'alice');
    expect(alice.zoneIds.sort()).toEqual([inbox.id, shared.id, personal.id, project.id].sort());

    const bob = await getZoneAccess(storage, 'bob');
    expect(bob.zoneIds).toEqual([inbox.id, shared.id]);
  });

  it('excludes archived zones and private zones without membership', async () => {
    const storage = new FakeStorage();
    const { personal, project } = await seededZones(storage);
    await storage.updateZone({ ...project, status: 'archived' });

    const access = await getZoneAccess(storage, 'alice');
    expect(access.zoneIds).toContain(personal.id);
    expect(access.zoneIds).not.toContain(project.id);
  });
});

describe('resolveZoneForWrite', () => {
  it('honors an explicit zone id', async () => {
    const storage = new FakeStorage();
    const { project } = await seededZones(storage);
    const embed = new OfflineEmbedder(8);
    const outcome = await resolveZoneForWrite({
      storage,
      embed,
      unit: newUnit({ zoneId: project.id, title: 'anything' }),
      zones: await storage.listZones(),
    });
    expect(outcome.via).toBe('explicit');
    expect(outcome.zone.id).toBe(project.id);
  });

  it('rejects an explicit zone that does not exist or is not accessible', async () => {
    const storage = new FakeStorage();
    await seededZones(storage);
    const embed = new OfflineEmbedder(8);
    await expect(
      resolveZoneForWrite({
        storage,
        embed,
        unit: newUnit({ zoneId: 'z_nope', title: 'x' }),
        zones: await storage.listZones(),
      }),
    ).rejects.toThrow(/not found/);
  });

  it('routes by tag rules before any LLM/embedding pass', async () => {
    const storage = new FakeStorage();
    const { project } = await seededZones(storage);
    const embed = new OfflineEmbedder(8);
    const outcome = await resolveZoneForWrite({
      storage,
      embed,
      llm: new MockLlmClient({ [LLM_ZONE_ASSIGN_INTENT]: () => ({ zoneSlug: 'shared', confidence: 1 }) }),
      unit: newUnit({ title: 'Deploy notes', tags: ['infra'] }),
      zones: await storage.listZones(),
    });
    expect(outcome.via).toBe('rules');
    expect(outcome.zone.id).toBe(project.id);
  });

  it('routes personal preferences to the personal zone', async () => {
    const storage = new FakeStorage();
    const { personal } = await seededZones(storage);
    const embed = new OfflineEmbedder(8);
    const outcome = await resolveZoneForWrite({
      storage,
      embed,
      unit: newUnit({ type: 'preference', title: 'Prefer pnpm over yarn' }),
      zones: await storage.listZones(),
    });
    expect(outcome.via).toBe('rules');
    expect(outcome.zone.id).toBe(personal.id);
  });

  it('uses centroid routing with a real embedder (threshold 0.6)', async () => {
    const storage = new FakeStorage();
    const { project } = await seededZones(storage);
    await storage.updateZone({ ...project, embeddingCentroid: JSON.stringify(V_A) });
    const embed = new TableEmbedder(new Map([['docker deploy production', V_A]]));

    const outcome = await resolveZoneForWrite({
      storage,
      embed,
      unit: newUnit({ title: 'docker deploy production', body: 'docker deploy production' }),
      text: 'docker deploy production',
      zones: await storage.listZones(),
    });
    expect(outcome.via).toBe('centroid');
    expect(outcome.zone.id).toBe(project.id);
  });

  it('skips the centroid branch when the embedder is offline', async () => {
    const storage = new FakeStorage();
    const { inbox, project } = await seededZones(storage);
    await storage.updateZone({ ...project, embeddingCentroid: JSON.stringify(V_A) });
    const embed = new OfflineEmbedder(8);

    const outcome = await resolveZoneForWrite({
      storage,
      embed,
      unit: newUnit({ title: 'unmatched title without rules' }),
      zones: await storage.listZones(),
    });
    expect(outcome.via).toBe('inbox');
    expect(outcome.zone.id).toBe(inbox.id);
  });

  it('falls back to the LLM when rules and centroids miss', async () => {
    const storage = new FakeStorage();
    const { project } = await seededZones(storage);
    const embed = new TableEmbedder(new Map([['weird text', [0.5, 0.5, 0, 0, 0, 0, 0, 0]]]));
    const llm = new MockLlmClient({
      [LLM_ZONE_ASSIGN_INTENT]: () => ({ zoneSlug: 'infra', confidence: 0.9 }),
    });

    const outcome = await resolveZoneForWrite({
      storage,
      embed,
      llm,
      unit: newUnit({ title: 'weird text', body: 'weird text' }),
      zones: await storage.listZones(),
    });
    expect(outcome.via).toBe('llm');
    expect(outcome.zone.id).toBe(project.id);
  });

  it('lands uncategorized memory in the inbox', async () => {
    const storage = new FakeStorage();
    const { inbox } = await seededZones(storage);
    const embed = new OfflineEmbedder(8);
    const outcome = await resolveZoneForWrite({
      storage,
      embed,
      unit: newUnit({ title: 'a completely unique thought' }),
      zones: await storage.listZones(),
    });
    expect(outcome.via).toBe('inbox');
    expect(outcome.zone.id).toBe(inbox.id);
  });
});

describe('service integration: auto-assignment + provenance', () => {
  it('auto-assigns saveUnit writes and records createdByUserId', async () => {
    const storage = new FakeStorage();
    const { project } = await seededZones(storage);
    await storage.addZoneMember(project.id, 'alice', 'editor');
    const service = await createService(testConfig(), storage);

    const saved = await runWithRequestContext(
      {
        workspaceId: 'ws_1',
        workspaceSlug: 'ws1',
        userId: 'alice',
        scopes: ['read', 'write'],
        realm: 'user',
        authEnabled: true,
      },
      () =>
        service.saveUnit(
          newUnit({
            title: 'Rollout runbook',
            summary: 'how to deploy',
            body: 'docker compose up',
            tags: ['infra'],
          }),
        ),
    );
    expect(saved.zoneId).toBe(project.id);
    expect(saved.createdByUserId).toBe('alice');
  });

  it('keeps the zone of an updated unit', async () => {
    const storage = new FakeStorage();
    const { project } = await seededZones(storage);
    await storage.addZoneMember(project.id, 'alice', 'editor');
    const service = await createService(testConfig(), storage);
    const first = await runWithRequestContext(
      { workspaceId: 'ws_1', workspaceSlug: 'ws1', userId: 'alice', scopes: ['read', 'write'], realm: 'user', authEnabled: true },
      () => service.saveUnit(newUnit({ title: 'Notes', tags: ['infra'] })),
    );
    expect(first.zoneId).toBe(project.id);

    const updated = await runWithRequestContext(
      { workspaceId: 'ws_1', workspaceSlug: 'ws1', userId: 'alice', scopes: ['read', 'write'], realm: 'user', authEnabled: true },
      () => service.saveUnit({ ...newUnit({ id: first.id, tags: [] }), title: 'Notes v2' }),
    );
    expect(updated.zoneId).toBe(project.id);
  });

  it('passes an explicit zone through ingest', async () => {
    const storage = new FakeStorage();
    const { project } = await seededZones(storage);
    const service = await createService(testConfig(), storage, {
      llm: new MockLlmClient({ 'atomic knowledge units': () => ({ units: [] }) }),
    });
    const result = await service.ingest({
      title: 'Long transcript',
      content: 'One fact worth remembering. Another useful detail.',
      zoneId: project.id,
    });
    expect(result.units.length).toBeGreaterThan(0);
    for (const unit of result.units) expect(unit.zoneId).toBe(project.id);
  });
});

describe('recall crossZone', () => {
  it('crossZone=true skips auto-routing and searches every accessible zone', async () => {
    const storage = new FakeStorage({ workspaceId: 'ws_1' });
    const zones = await seededZones(storage);
    const config = testConfig();
    // Strong match in the infra partition; unrelated unit in shared.
    await storage.createUnit(
      makeUnit({
        id: 'u_infra',
        title: 'Deploy infra production',
        body: 'Deploy infra production with docker compose',
        tags: ['infra'],
        zoneId: zones.project.id,
        status: 'reviewed',
        embedding: { dims: 8, values: V_A },
      }),
    );
    await storage.createUnit(
      makeUnit({
        id: 'u_shared',
        title: 'Cookie recipe',
        body: 'A cookie recipe for the team kitchen',
        tags: ['shared'],
        zoneId: zones.shared.id,
        status: 'reviewed',
        embedding: { dims: 8, values: V_B },
      }),
    );
    const embedder = new TableEmbedder(new Map([['deploy infra production', V_A]]));
    const ctx = {
      workspaceId: 'ws_1',
      workspaceSlug: 'ws1',
      scopes: ['read', 'write', 'admin'],
      realm: 'anonymous' as const,
      authEnabled: false,
      zoneIds: [zones.project.id, zones.shared.id, zones.inbox.id],
    };

    await runWithRequestContext(ctx, async () => {
      // Default: auto-route to infra → the shared partition stays isolated.
      const routed = await recall(storage, embedder, config, {
        query: 'deploy infra production',
      });
      expect(routed.routedZone?.id).toBe(zones.project.id);
      const routedTitles = routed.items.map((i) => i.unit.title);
      expect(routedTitles).toContain('Deploy infra production');
      expect(routedTitles).not.toContain('Cookie recipe');

      // crossZone=true: no routing bias, every accessible zone is searchable.
      const crossed = await recall(storage, embedder, config, {
        query: 'deploy infra production',
        crossZone: true,
      });
      expect(crossed.routedZone).toBeUndefined();
      const crossedTitles = crossed.items.map((i) => i.unit.title);
      expect(crossedTitles).toContain('Deploy infra production');
      expect(crossedTitles).toContain('Cookie recipe');
    });
  });
});

describe('recomputeZoneCentroids', () => {
  it('averages unit embeddings per zone with an API embedder', async () => {
    const storage = new FakeStorage();
    const { project } = await seededZones(storage);
    storage.createUnit(
      makeUnit({ id: 'u1', zoneId: project.id, embedding: { dims: 8, values: V_A } }),
    );
    storage.createUnit(
      makeUnit({ id: 'u2', zoneId: project.id, embedding: { dims: 8, values: V_A } }),
    );

    const embed = new TableEmbedder(new Map());
    const report = await recomputeZoneCentroids(storage, embed);
    expect(report.updated).toBe(1);
    const zone = await storage.getZone(project.id);
    expect(zone?.embeddingCentroid).toBe(JSON.stringify(V_A));
  });

  it('skips offline embedders', async () => {
    const storage = new FakeStorage();
    await seededZones(storage);
    const report = await recomputeZoneCentroids(storage, new OfflineEmbedder(8));
    expect(report.skippedOffline).toBe(true);
    expect(report.updated).toBe(0);
  });
});

describe('proposeNewZones', () => {
  it('proposes a cluster of at least 5 related inbox units', async () => {
    const storage = new FakeStorage();
    const { inbox } = await seededZones(storage);
    for (let i = 0; i < 6; i += 1) {
      storage.createUnit(
        makeUnit({
          id: `u${i}`,
          zoneId: inbox.id,
          title: `backend service ${i}`,
          tags: ['backend'],
          embedding: { dims: 8, values: V_A },
        }),
      );
    }
    storage.createUnit(
      makeUnit({
        id: 'u9',
        zoneId: inbox.id,
        title: 'unrelated gardening',
        tags: [],
        embedding: { dims: 8, values: V_B },
      }),
    );

    const proposals = await proposeNewZones(storage, new TableEmbedder(new Map()), {
      similarity: 0.6,
      minClusterSize: 5,
    });
    expect(proposals.length).toBeGreaterThan(0);
    const top = proposals[0];
    expect(top.size).toBe(6);
    expect(top.name.toLowerCase()).toContain('backend');
    expect(top.slug).toBe('backend');
    expect(top.unitIds).toHaveLength(6);
  });
});
