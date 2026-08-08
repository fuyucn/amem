import { describe, expect, it } from 'vitest';
import {
  segmentTranscript,
  upsertScenes,
  extractScenesFromTranscript,
  mergeConfig,
  type AmemConfig,
} from '../src/index.js';
import { FakeStorage } from './helpers.js';

function cfg(): AmemConfig {
  return mergeConfig({
    embedding: { mode: 'offline', dims: 64 },
    jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 },
    thresholds: { maxScenarios: 12 },
  });
}

describe('segmentTranscript', () => {
  it('splits a transcript into topic-consistent scenes', () => {
    const raw = [
      'user: Let us set up the deploy pipeline with docker compose',
      'assistant: Use docker compose up for local development',
      'user: Now about the react query cache invalidation strategy',
      'assistant: Invalidate the react query cache on every mutation',
    ].join('\n');
    const segs = segmentTranscript(raw);
    expect(segs.length).toBe(2);
    expect(segs[0].title.toLowerCase()).toContain('deploy');
    expect(segs[1].title.toLowerCase()).toContain('react');
    expect(segs[0].turnCount).toBe(2);
  });

  it('keeps one topic in a single scene', () => {
    const raw = [
      'user: Design the oauth authorization flow with scoped access tokens',
      'assistant: Use the oauth authorization server with scoped tokens and refresh rotation',
      'user: Also enforce scoped workspace project tokens for each area',
      'assistant: Grant scoped read write tokens per project workspace',
    ].join('\n');
    const segs = segmentTranscript(raw);
    expect(segs.length).toBe(1);
    expect(segs[0].title.toLowerCase()).toContain('scoped');
  });

  it('hard-splits a scene that exceeds maxTurnsPerScene', () => {
    const turns = ['user: topic alpha continues here', 'assistant: reply about the same topic'];
    const raw = Array.from({ length: 8 }, () => turns).flat().join('\n');
    const segs = segmentTranscript(raw, { maxTurnsPerScene: 3 });
    expect(segs.every((s) => s.turnCount <= 3)).toBe(true);
    expect(segs.length).toBeGreaterThanOrEqual(3);
  });

  it('ignores role-less lines without producing empty scenes', () => {
    const segs = segmentTranscript('plain text without any role markers\nmore text');
    expect(segs.length).toBe(0);
  });
});

describe('upsertScenes', () => {
  it('creates a scene with heat 1 on first sight', async () => {
    const storage = new FakeStorage();
    const report = await extractScenesFromTranscript(
      storage,
      cfg(),
      'user: We should build the reporting dashboard with realtime charts\nassistant: Use websockets to stream realtime charts into the reporting dashboard',
    );
    expect(report.scenesCreated).toBe(1);
    expect(report.scenesUpdated).toBe(0);
    const scenes = await storage.listScenarios({ status: 'active' });
    expect(scenes).toHaveLength(1);
    expect(scenes[0].heat).toBe(1);
    expect(scenes[0].tags).toContain('scene');
    const event = storage.events.find((e) => e.kind === 'scene_extract');
    expect(event).toBeTruthy();
  });

  it('updates an existing scene and bumps its heat instead of duplicating', async () => {
    const storage = new FakeStorage();
    const raw1 = 'user: Configure the ci pipeline for multi stage builds\nassistant: Deploy pipeline stages with lint and tests';
    const raw2 = 'user: Continue configuring the ci pipeline deploy builds multi stage caching strategy\nassistant: Cache node modules across the pipeline deploy stages builds multi lint tests';
    const r1 = await extractScenesFromTranscript(storage, cfg(), raw1);
    const r2 = await extractScenesFromTranscript(storage, cfg(), raw2);
    expect(r1.scenesCreated).toBe(1);
    expect(r2.scenesCreated).toBe(0);
    expect(r2.scenesUpdated).toBeGreaterThanOrEqual(1);
    const scenes = await storage.listScenarios({ status: 'active' });
    expect(scenes).toHaveLength(1);
    expect(scenes[0].heat).toBeGreaterThanOrEqual(2);
    expect(scenes[0].content.toLowerCase()).toContain('cache');
  });

  it('merges into the most similar scene when over the cap', async () => {
    const storage = new FakeStorage();
    const config = cfg();
    config.thresholds.maxScenarios = 2;
    await upsertScenes(storage, config, [
      {
        title: 'Deploy pipeline setup',
        summary: 'docker compose deploy',
        content: '- docker compose up',
        tags: ['deploy', 'scene'],
        turnCount: 1,
      },
      {
        title: 'React query patterns',
        summary: 'cache invalidation',
        content: '- invalidate on mutation',
        tags: ['react', 'scene'],
        turnCount: 1,
      },
    ]);
    const report = await upsertScenes(storage, config, [
      {
        title: 'Payment integration strategy',
        summary: 'stripe checkout flow',
        content: '- stripe checkout flow',
        tags: ['payments', 'scene'],
        turnCount: 1,
      },
    ]);
    expect(report.scenesMerged).toBe(1);
    const scenes = await storage.listScenarios({ status: 'active' });
    expect(scenes).toHaveLength(2);
    const deploy = scenes.find((s) => s.title.includes('Deploy'));
    expect(deploy?.content).toContain('stripe checkout');
  });

  it('dedupes folded content lines on merge', async () => {
    const storage = new FakeStorage();
    const config = cfg();
    const seg = {
      title: 'Backup strategy',
      summary: 'daily backups',
      content: '- snapshot the database daily',
      tags: ['backup', 'scene'],
      turnCount: 1,
    };
    await upsertScenes(storage, config, [seg]);
    await upsertScenes(storage, config, [
      { ...seg, content: '- snapshot the database daily\n- keep two weeks of history' },
    ]);
    const scenes = await storage.listScenarios({ status: 'active' });
    expect(scenes[0].content.split('\n').filter((l) => l.includes('snapshot the database daily'))).toHaveLength(1);
    expect(scenes[0].content).toContain('keep two weeks of history');
  });
});
