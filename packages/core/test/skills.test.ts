import { describe, expect, it } from 'vitest';
import {
  MockLlmClient,
  extractSkills,
  LLM_SKILL_INTENT,
  type LlmClient,
} from '../src/index.js';
import { FakeStorage, makeUnit } from './helpers.js';

describe('extractSkills', () => {
  it('is idempotent: re-running with unchanged content is a true no-op', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(
      makeUnit({
        id: 'p1',
        type: 'procedure',
        title: 'Ship a release',
        body: '1. bump version\n2. run tests\n3. tag',
        summary: 'Release procedure',
        status: 'reviewed',
      }),
    );
    const llm = new MockLlmClient({});

    const first = await extractSkills(llm, storage, { includePending: true });
    expect(first.created).toBe(1);
    expect(first.updated).toBe(0);

    const second = await extractSkills(llm, storage, { includePending: true });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);

    const assets = await storage.listAssets({ kind: 'skill' });
    expect(assets).toHaveLength(1);
    expect(assets[0].sourceUnitIds).toContain('p1');
    expect(assets[0].version).toBe(1);
    expect(await storage.listAssetVersions(assets[0].id)).toHaveLength(0);
  });

  it('uses LLM extraction when the model returns skills', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(
      makeUnit({ id: 'd1', type: 'decision', title: 'Use pnpm workspaces', body: 'monorepo', summary: 'pick pnpm', status: 'reviewed' }),
    );
    const llm = new MockLlmClient({
      [LLM_SKILL_INTENT]: () => ({
        skills: [
          {
            name: 'Bootstrap a pnpm workspace',
            description: 'Scaffold a monorepo',
            trigger: 'when starting a monorepo',
            steps: ['install pnpm', 'create packages/'],
            validation: 'pnpm install works',
            tags: ['monorepo'],
          },
        ],
      }),
    });
    const result = await extractSkills(llm, storage, { includePending: true });
    expect(result.created).toBe(1);
    const assets = await storage.listAssets({ kind: 'skill' });
    expect(assets[0].name).toBe('Bootstrap a pnpm workspace');
    expect(JSON.parse(assets[0].content).steps).toHaveLength(2);
  });

  it('skips pending units by default', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(
      makeUnit({ id: 'p2', type: 'procedure', title: 'Pending skill', body: 'do it', summary: 'x', status: 'pending' }),
    );
    const result = await extractSkills(new MockLlmClient({}), storage);
    expect(result.created).toBe(0);
  });

  it('heuristic mode extracts skills without any LLM call', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(
      makeUnit({
        id: 'h1',
        type: 'procedure',
        title: 'Backup the database',
        body: '1. stop the container\n2. copy the db file\n3. start the container',
        summary: 'Routine DB backup',
        status: 'reviewed',
      }),
    );
    let calls = 0;
    const counting: LlmClient = {
      complete: async () => { calls++; return ''; },
      completeJSON: async () => { calls++; return { skills: [] }; },
    };

    const result = await extractSkills(counting, storage, { includePending: true, heuristic: true });

    expect(calls).toBe(0);
    expect(result.created).toBe(1);
    const assets = await storage.listAssets({ kind: 'skill' });
    expect(assets[0].name).toBe('Backup the database');
    expect(JSON.parse(assets[0].content).steps.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps a version chain: content changes snapshot the previous skill version', async () => {
    const storage = new FakeStorage();
    await storage.createUnit(
      makeUnit({
        id: 'v1',
        type: 'procedure',
        title: 'Rotate DB credentials',
        body: '1. stop container\n2. rotate secret',
        summary: 'Credential rotation',
        status: 'reviewed',
      }),
    );
    const llm = new MockLlmClient({});

    const first = await extractSkills(llm, storage, { includePending: true, heuristic: true });
    expect(first.created).toBe(1);
    const asset = (await storage.listAssets({ kind: 'skill' }))[0]!;
    expect(asset.version).toBe(1);
    expect(await storage.listAssetVersions(asset.id)).toHaveLength(0);

    // Same extraction with identical content: no new snapshot, version unchanged.
    const second = await extractSkills(llm, storage, { includePending: true, heuristic: true });
    expect(second.updated).toBe(0);
    expect((await storage.listAssets({ kind: 'skill' }))[0]!.version).toBe(1);
    expect(await storage.listAssetVersions(asset.id)).toHaveLength(0);

    // Content change: old version is snapshotted before the update.
    await storage.updateUnit(
      makeUnit({
        id: 'v1',
        type: 'procedure',
        title: 'Rotate DB credentials',
        body: '1. stop container\n2. rotate secret\n3. verify new secret works',
        summary: 'Credential rotation',
        status: 'reviewed',
      }),
    );
    const third = await extractSkills(llm, storage, { includePending: true, heuristic: true });
    expect(third.updated).toBeGreaterThan(0);
    const current = (await storage.listAssets({ kind: 'skill' }))[0]!;
    expect(current.version).toBe(2);
    const versions = await storage.listAssetVersions(current.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.reason).toContain('content changed');
    expect((versions[0]!.snapshot as { body: string }).body).not.toContain('verify new secret');
  });
});
