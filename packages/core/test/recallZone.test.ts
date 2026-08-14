import { describe, expect, it } from 'vitest';
import {
  createService,
  mergeConfig,
  runWithRequestContext,
  type AmemConfig,
  type Embedder,
  type Unit,
  type Zone,
} from '../src/index.js';
import { FakeStorage, iso, makeUnit, seedDefaultZones } from './helpers.js';

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

async function seededZones(storage: FakeStorage): Promise<{
  inbox: Zone;
  shared: Zone;
  ops: Zone;
  personal: Zone;
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
  const ops = await storage.createZone({
    workspaceId: 'ws_1',
    slug: 'ops',
    name: 'Deploy',
    kind: 'project',
    visibility: 'members',
  });
  const personal = await storage.createZone({
    workspaceId: 'ws_1',
    slug: 'personal-user',
    name: 'Personal',
    kind: 'personal',
    visibility: 'private',
    ownerUserId: 'alice',
  });
  return { inbox, shared, ops, personal };
}

function unitIn(zoneId: string, over: Partial<Unit> & { id: string; title: string }): Unit {
  return makeUnit({ ...over, zoneId });
}

function aliceCtx(zoneIds: string[]) {
  return {
    workspaceId: 'ws_1',
    workspaceSlug: 'ws1',
    userId: 'alice',
    zoneIds,
    scopes: ['read', 'write', 'admin'],
    realm: 'user' as const,
    authEnabled: true,
  };
}

describe('recall zone routing', () => {
  it('restricts recall to an explicit zone (id or slug) and annotates items', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    await storage.createUnit(
      unitIn(zones.ops.id, { id: 'u1', title: 'Deploy runbook', summary: 'Roll out v2', body: 'kubectl apply' }),
    );
    await storage.createUnit(
      unitIn(zones.shared.id, { id: 'u2', title: 'Team lunch', summary: 'Wednesdays', body: 'canteen' }),
    );
    const service = await createService(testConfig(), storage);

    const bySlug = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.shared.id, zones.ops.id]),
      () => service.recall({ query: 'deploy bug', zone: zones.ops.slug, topK: 20 }),
    );
    expect(bySlug.routedZone).toEqual({
      id: zones.ops.id,
      slug: zones.ops.slug,
      name: zones.ops.name,
      reason: 'explicit',
    });
    expect(bySlug.items.map((i) => i.unit.id)).toEqual(['u1']);
    expect(bySlug.items[0].unit.zoneSlug).toBe(zones.ops.slug);
    expect(bySlug.items[0].unit.zoneName).toBe(zones.ops.name);
    expect(bySlug.items[0].zoneId).toBe(zones.ops.id);

    const byId = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.shared.id, zones.ops.id]),
      () => service.recall({ query: 'deploy bug', zone: zones.ops.id, topK: 20 }),
    );
    expect(byId.items.map((i) => i.unit.id)).toEqual(['u1']);
  });

  it('auto-routes to the matching zone when the query names it', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    await storage.createUnit(
      unitIn(zones.ops.id, { id: 'u1', title: 'Rollout plan', summary: 'Deploy v2', body: 'canary then full' }),
    );
    await storage.createUnit(
      unitIn(zones.shared.id, { id: 'u2', title: 'Team lunch', summary: 'Wednesdays', body: 'canteen' }),
    );
    const service = await createService(
      testConfig(),
      storage,
      { embed: new TableEmbedder(new Map([['deploy', V_A]]), 8) },
    );

    const result = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.shared.id, zones.ops.id]),
      () => service.recall({ query: 'deploy', topK: 20 }),
    );
    expect(result.routedZone?.id).toBe(zones.ops.id);
    expect(result.routedZone?.reason).toContain('auto-routed');
    expect(result.items.map((i) => i.unit.id)).toEqual(['u1']);
    expect(result.items[0].zoneId).toBe(zones.ops.id);
  });

  it('never returns units outside the accessible zone set (strict isolation)', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    await storage.createUnit(
      unitIn(zones.ops.id, { id: 'u1', title: 'Deploy runbook', summary: 'Roll out v2', body: 'kubectl apply' }),
    );
    await storage.createUnit(
      unitIn(zones.shared.id, { id: 'u2', title: 'Shared deploy notes', summary: 'Everyone', body: 'deploy checklists' }),
    );
    const service = await createService(testConfig(), storage);

    // Caller only has inbox + ops. The shared unit is not accessible even
    // though it matches the query keywords; the query itself does not name
    // any zone, so no auto-routing hides the isolation boundary.
    const result = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.ops.id]),
      () => service.recall({ query: 'kubectl rollout checklist', topK: 20 }),
    );
    expect(result.items.map((i) => i.unit.id)).toEqual(['u1']);
  });

  it('falls back to all zones when the auto-routed zone has only weak matches', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    // The target lives in Inbox, but the query contains the word "shared",
    // which auto-routes to the Shared zone. Without the fallback the target
    // is filtered out entirely (misrouting, not isolation).
    await storage.createUnit(
      unitIn(zones.inbox.id, {
        id: 'u1',
        title: 'Mount shared HTTP MCP at /mcp',
        summary: 'Server mounts the MCP endpoint',
        body: 'packages/server mounts the shared HTTP MCP server at /mcp',
      }),
    );
    // Weak match inside the routed zone keeps auto-routing active but weak.
    await storage.createUnit(
      unitIn(zones.shared.id, {
        id: 'u2',
        title: 'Lunch menu',
        summary: 'Wednesdays',
        body: 'canteen',
      }),
    );
    const service = await createService(
      testConfig(),
      storage,
      { embed: new TableEmbedder(new Map([['mounts', V_A]]), 8) },
    );

    const result = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.shared.id, zones.ops.id]),
      () => service.recall({ query: 'Main server mounts shared HTTP MCP at /mcp', topK: 20 }),
    );
    expect(result.routedZone?.id).toBe(zones.shared.id);
    expect(result.items[0].unit.id).toBe('u1');
  });

  it('keeps unassigned Inbox units reachable when auto-routing to a strong personal match', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    // The target lives in Inbox (uncategorized memory). The query routes to
    // the Personal zone because of the "user" slug token, and the personal
    // zone has a decent match of its own — before the fix the scoped recall
    // returned that match and the Inbox target was filtered out entirely.
    await storage.createUnit(
      unitIn(zones.inbox.id, {
        id: 'u1',
        title: 'Real vision key pending user',
        summary: 'Real vision key must be provided by user',
        body: 'The only remaining item is that a real vision API key needs to be supplied by the user',
        tags: ['vision', 'api-key', 'pending'],
      }),
    );
    await storage.createUnit(
      unitIn(zones.personal.id, {
        id: 'u2',
        title: 'Mock vision endpoint behavior',
        summary: 'Mock vision endpoint with ocrPages=1 makes distilled facts searchable',
        body: 'mock vision',
        tags: ['mock', 'vision', 'search'],
      }),
    );
    const service = await createService(testConfig(), storage);

    const result = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.shared.id, zones.ops.id, zones.personal.id]),
      () =>
        service.recall({
          query: 'Real vision key pending must be provided by user',
          topK: 20,
        }),
    );
    expect(result.routedZone?.id).toBe(zones.personal.id);
    expect(result.items[0].unit.id).toBe('u1');
  });

  it('still excludes other personal zones when auto-routing (isolation preserved)', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    const bob = await storage.createZone({
      workspaceId: 'ws_1',
      slug: 'personal-bob',
      name: 'Personal',
      kind: 'personal',
      visibility: 'private',
      ownerUserId: 'bob',
    });
    await storage.createUnit(
      unitIn(zones.personal.id, {
        id: 'u1',
        title: 'Deploy runbook',
        summary: 'Roll out v2',
        body: 'kubectl apply',
      }),
    );
    await storage.createUnit(
      unitIn(bob.id, {
        id: 'u2',
        title: 'Deploy runbook (bob private)',
        summary: 'Roll out v2',
        body: 'kubectl apply private notes',
      }),
    );
    const service = await createService(testConfig(), storage);

    const result = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.shared.id, zones.ops.id, zones.personal.id]),
      () => service.recall({ query: 'deploy kubectl rollout', topK: 20 }),
    );
    expect(result.items.map((i) => i.unit.id)).toEqual(['u1']);
  });

  it('does not route on a substring of a zone identity (persona != personal)', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    await storage.createUnit(
      unitIn(zones.inbox.id, {
        id: 'u1',
        title: 'interface: Persona — domain.ts',
        summary: 'export interface Persona {',
        body: 'export interface Persona { name: string; traits: string[] }',
      }),
    );
    const service = await createService(
      testConfig(),
      storage,
      { embed: new TableEmbedder(new Map([['interface', V_A]]), 8) },
    );

    const result = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.shared.id, zones.ops.id]),
      () =>
        service.recall({
          query: 'interface Persona domain.ts export interface Persona {',
          topK: 20,
        }),
    );
    // "persona" is a substring of the Personal zone slug, but not a token:
    // routing must stay off so the Inbox unit remains reachable.
    expect(result.routedZone).toBeUndefined();
    expect(result.items[0].unit.id).toBe('u1');
  });

  it('rejects an explicit zone the caller cannot access', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    const service = await createService(testConfig(), storage);
    await expect(
      runWithRequestContext(
        aliceCtx([zones.inbox.id]),
        () => service.recall({ query: 'anything', zone: zones.shared.slug }),
      ),
    ).rejects.toThrow(/not accessible/);
  });
});

describe('layered recall zone routing', () => {
  it('narrows L1 units and L2 scenarios to the explicit zone', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    await storage.createUnit(
      unitIn(zones.ops.id, { id: 'u1', title: 'Deploy runbook', summary: 'Roll out v2', body: 'kubectl apply' }),
    );
    await storage.createUnit(
      unitIn(zones.ops.id, { id: 'u3', title: 'Deploy checklist', summary: 'Pre-flight', body: 'verify canary' }),
    );
    await storage.createUnit(
      unitIn(zones.shared.id, { id: 'u2', title: 'Team lunch', summary: 'Wednesdays', body: 'canteen' }),
    );
    await storage.createScenario({
      id: 's1',
      title: 'Deploy day',
      summary: 'Release procedures',
      content: 'Checklist for shipping v2',
      tags: ['deploy'],
      sourceUnitIds: ['u3'],
      status: 'active',
      version: 1,
      heat: 10,
      createdAt: iso(),
      updatedAt: iso(),
    });
    await storage.createScenario({
      id: 's2',
      title: 'Canteen',
      summary: 'Lunch',
      content: 'Weekly menu',
      tags: ['food'],
      sourceUnitIds: ['u2'],
      status: 'active',
      version: 1,
      heat: 0,
      createdAt: iso(),
      updatedAt: iso(),
    });
    const service = await createService(testConfig(), storage);

    const result = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.shared.id, zones.ops.id]),
      () => service.recallLayered({ query: 'deploy procedures', zone: zones.ops.slug, topK: 20 }),
    );
    expect(result.routedZone?.id).toBe(zones.ops.id);
    expect(result.scenarios.map((s) => s.scenario.id)).toEqual(['s1']);
    expect(result.units.map((i) => i.unit.id)).toEqual(['u1']);
    expect(result.units[0].zoneId).toBe(zones.ops.id);
  });
});

describe('search zone routing', () => {
  it('restricts search to the requested zone', async () => {
    const storage = new FakeStorage();
    const zones = await seededZones(storage);
    await storage.createUnit(
      unitIn(zones.ops.id, { id: 'u1', title: 'Deploy runbook', summary: 'Roll out v2', body: 'kubectl apply' }),
    );
    await storage.createUnit(
      unitIn(zones.shared.id, { id: 'u2', title: 'Deploy notes', summary: 'Everyone', body: 'deploy checklists' }),
    );
    const service = await createService(testConfig(), storage);

    const result = await runWithRequestContext(
      aliceCtx([zones.inbox.id, zones.shared.id, zones.ops.id]),
      () => service.search('deploy', { zone: zones.ops.slug }),
    );
    expect(result.items.map((i) => i.unit.id)).toEqual(['u1']);
    expect(result.items[0].unit.zoneSlug).toBe(zones.ops.slug);
  });
});

describe('seedDefaultZones smoke (production shape)', () => {
  it('seeds inbox+shared for the default workspace', async () => {
    const storage = new FakeStorage();
    const { inbox, shared } = await seedDefaultZones(storage);
    expect(inbox.kind).toBe('inbox');
    expect(shared.kind).toBe('shared');
    expect((await storage.listZones()).length).toBe(2);
    const svc = await createService(testConfig(), storage);
    // default anonymous context resolves writes into the seeded inbox
    const unit = await svc.saveUnit({ type: 'fact', title: 'Falls into inbox', summary: 's', body: 'b' });
    expect(unit.zoneId).toBe(inbox.id);
  });
});
