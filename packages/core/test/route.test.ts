import { describe, expect, it } from 'vitest';
import { agentCanUse, routeAssets, type Asset, type AssetKind } from '../src/index.js';
import { FakeStorage, iso } from './helpers.js';

function makeAsset(over: Partial<Asset>): Asset {
  return {
    id: 'a1',
    kind: 'skill',
    name: 'Sample skill',
    description: 'description',
    content: '{}',
    body: 'body',
    trigger: '',
    tags: [],
    sourceUnitIds: [],
    status: 'published',
    visibility: 'workspace',
    boundAgents: [],
    version: 1,
    createdAt: iso(),
    updatedAt: iso(),
    ...over,
  };
}

describe('routeAssets', () => {
  it('ranks name matches above trigger matches above body-only matches', async () => {
    const storage = new FakeStorage();
    await storage.createAsset(
      makeAsset({ id: 'name', name: 'Deploy docker to production', description: 'release', trigger: '' }),
    );
    await storage.createAsset(
      makeAsset({
        id: 'trigger',
        name: 'Ops handbook',
        description: 'general operations',
        trigger: 'when deploying docker to production',
      }),
    );
    await storage.createAsset(
      makeAsset({
        id: 'body',
        name: 'Misc notes',
        description: 'unrelated',
        trigger: '',
        body: 'we deploy docker every friday',
      }),
    );

    const out = await routeAssets(storage, { task: 'deploy docker to production', limit: 3 });

    expect(out.items.map((i) => i.asset.id)).toEqual(['name', 'trigger', 'body']);
    expect(out.usedTokens).toBeGreaterThan(0);
  });

  it('filters by kind', async () => {
    const storage = new FakeStorage();
    await storage.createAsset(makeAsset({ id: 's1', name: 'Docker deploy skill', kind: 'skill' }));
    await storage.createAsset(
      makeAsset({ id: 'w1', name: 'Docker deploy wiki', kind: 'wiki', body: 'docker deploy steps' }),
    );

    const out = await routeAssets(storage, { task: 'docker deploy', kind: 'wiki' });

    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.asset.id).toBe('w1');
  });

  it('only routes published assets', async () => {
    const storage = new FakeStorage();
    await storage.createAsset(makeAsset({ id: 'pub', name: 'Docker deploy' }));
    await storage.createAsset(makeAsset({ id: 'draft', name: 'Docker deploy draft', status: 'draft' }));
    await storage.createAsset(makeAsset({ id: 'arch', name: 'Docker deploy archived', status: 'archived' }));

    const out = await routeAssets(storage, { task: 'docker deploy' });

    expect(out.items.map((i) => i.asset.id)).toEqual(['pub']);
  });

  it('respects agent visibility (public/workspace/private+binding)', async () => {
    const storage = new FakeStorage();
    await storage.createAsset(makeAsset({ id: 'pub', name: 'Docker deploy', visibility: 'public' }));
    await storage.createAsset(
      makeAsset({ id: 'team', name: 'Docker deploy team', visibility: 'team', boundAgents: ['alice'] }),
    );
    await storage.createAsset(
      makeAsset({ id: 'priv-bound', name: 'Docker deploy bound', visibility: 'private', boundAgents: ['alice'] }),
    );
    await storage.createAsset(
      makeAsset({ id: 'priv-other', name: 'Docker deploy other', visibility: 'private', boundAgents: ['bob'] }),
    );

    const forAlice = await routeAssets(storage, { task: 'docker deploy', agent: 'alice' });
    const anonymous = await routeAssets(storage, { task: 'docker deploy' });

    expect(forAlice.items.map((i) => i.asset.id).sort()).toEqual(['priv-bound', 'pub', 'team']);
    expect(anonymous.items.map((i) => i.asset.id).sort()).toEqual([
      'priv-bound',
      'priv-other',
      'pub',
      'team',
    ]);
  });

  it('honors limit', async () => {
    const storage = new FakeStorage();
    for (let i = 0; i < 5; i++) {
      await storage.createAsset(makeAsset({ id: `a${i}`, name: `Docker deploy guide ${i}` }));
    }

    const out = await routeAssets(storage, { task: 'docker deploy', limit: 2 });

    expect(out.items).toHaveLength(2);
  });
});

describe('agentCanUse', () => {
  const base = makeAsset({});
  it('allows public/workspace for any agent', () => {
    expect(agentCanUse({ ...base, visibility: 'public' }, 'alice')).toBe(true);
    expect(agentCanUse({ ...base, visibility: 'workspace' }, 'alice')).toBe(true);
    expect(agentCanUse({ ...base, visibility: 'public' })).toBe(true);
  });
  it('requires an explicit binding for private/team assets', () => {
    expect(agentCanUse({ ...base, visibility: 'private', boundAgents: ['alice'] }, 'alice')).toBe(true);
    expect(agentCanUse({ ...base, visibility: 'private', boundAgents: ['alice'] }, 'bob')).toBe(false);
    expect(agentCanUse({ ...base, visibility: 'team', boundAgents: [] }, 'alice')).toBe(false);
  });
  it('returns true when no agent is given', () => {
    expect(agentCanUse({ ...base, visibility: 'private', boundAgents: [] })).toBe(true);
  });
});

export type { AssetKind };
