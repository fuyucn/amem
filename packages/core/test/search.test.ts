import { describe, expect, it } from 'vitest';
import {
  createService, mergeConfig,
  type AmemConfig, type Unit,
} from '../src/index.js';
import { FakeStorage, makeUnit } from './helpers.js';

const cfg: AmemConfig = mergeConfig({
  embedding: { mode: 'offline', dims: 64 },
  jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 },
});

async function seededService(units: Unit[]) {
  const storage = new FakeStorage();
  for (const u of units) await storage.createUnit(u);
  const service = await createService(cfg, storage);
  return { storage, service };
}

describe('search keyword ranking', () => {
  it('ranks title hits above summary-only hits (field weighting)', async () => {
    const { service } = await seededService([
      makeUnit({ id: 'a', title: 'Quantum graph compaction', summary: 'compaction details', body: 'body' }),
      makeUnit({ id: 'b', title: 'Unrelated title', summary: 'only mentions quantum here', body: 'body' }),
    ]);
    const r = await service.search('quantum', { limit: 10 });
    expect(r.items[0].unit.id).toBe('a');
    expect(r.items[0].score).toBeGreaterThan(r.items[1].score);
    expect(r.items[0].via).toBe('keyword');
  });

  it('matches CJK characters and returns them as terms', async () => {
    const { service } = await seededService([
      makeUnit({ id: 'zh', title: '记忆管理系统的架构设计', summary: 'agent 长期记忆', body: 'body' }),
      makeUnit({ id: 'en', title: 'Unrelated docker setup', summary: 'other', body: 'body' }),
    ]);
    const r = await service.search('记忆', { limit: 10 });
    const zh = r.items.find((i) => i.unit.id === 'zh');
    expect(zh).toBeTruthy();
    expect(zh!.terms).toContain('记');
    expect(zh!.terms).toContain('忆');
    expect(zh!.score).toBeGreaterThan(0);
  });

  it('combines latin + CJK terms and scores both', async () => {
    const { service } = await seededService([
      makeUnit({ id: 'mix', title: '记忆 memory compaction', summary: 'memory 整理', body: 'body' }),
    ]);
    const r = await service.search('记忆 memory', { limit: 10 });
    expect(r.items[0].unit.id).toBe('mix');
    expect(r.items[0].terms).toContain('memory');
    expect(r.items[0].terms).toContain('记');
  });

  it('surfaces keyword hits before semantic-only matches even at small limits', async () => {
    const { service } = await seededService([
      makeUnit({ id: 'exact', title: 'Docker compose healthcheck config', summary: 'exact match', body: 'body' }),
      makeUnit({ id: 'filler', title: 'Unrelated deploy notes', summary: 'other', body: 'body' }),
      makeUnit({ id: 'filler2', title: 'Unrelated networking notes', summary: 'other', body: 'body' }),
    ]);
    const r = await service.search('healthcheck', { limit: 1 });
    expect(r.items.map((i) => i.unit.id)).toEqual(['exact']);
    expect(r.items[0].terms).toContain('healthcheck');
  });
});

describe('search filters', () => {
  const units: Unit[] = [
    makeUnit({
      id: 'u1', type: 'decision', title: 'Choose Postgres', summary: 'db pick',
      tags: ['db'], labels: { category: 'infra' }, status: 'reviewed',
    }),
    makeUnit({
      id: 'u2', type: 'lesson', title: 'Postgres pitfalls', summary: 'learned',
      tags: ['db'], labels: { category: 'code' }, status: 'reviewed',
    }),
    makeUnit({
      id: 'u3', type: 'fact', title: 'Postgres versions', summary: 'facts',
      tags: ['release'], labels: { category: 'research' }, status: 'pending',
    }),
    makeUnit({
      id: 'u4', type: 'fact', title: 'Old Postgres note', summary: 'archived',
      tags: ['db'], labels: { category: 'infra' }, status: 'archived',
    }),
  ];

  it('excludes archived units by default', async () => {
    const { service } = await seededService(units);
    const r = await service.search('postgres', { limit: 10 });
    expect(r.items.some((i) => i.unit.id === 'u4')).toBe(false);
  });

  it('filters by status', async () => {
    const { service } = await seededService(units);
    const r = await service.search('postgres', { status: 'pending', limit: 10 });
    expect(r.items.map((i) => i.unit.id)).toEqual(['u3']);
  });

  it('filters by type', async () => {
    const { service } = await seededService(units);
    const r = await service.search('postgres', { type: 'lesson', limit: 10 });
    expect(r.items.map((i) => i.unit.id)).toEqual(['u2']);
  });

  it('filters by category label', async () => {
    const { service } = await seededService(units);
    const r = await service.search('postgres', { category: 'infra', limit: 10 });
    expect(r.items.map((i) => i.unit.id).sort()).toEqual(['u1']);
  });

  it('filters by tag', async () => {
    const { service } = await seededService(units);
    const r = await service.search('postgres', { tag: 'release', limit: 10 });
    expect(r.items.map((i) => i.unit.id)).toEqual(['u3']);
  });
});

describe('search fullText', () => {
  it('matches terms inside the body beyond the head when fullText is set', async () => {
    const headOnly = 'x'.repeat(600);
    const { service } = await seededService([
      makeUnit({ id: 'deep', title: 'Noise title', summary: 'noise', body: `${headOnly} needle-in-the-haystack phrase` }),
    ]);
    const head = await service.search('needle', { limit: 10 });
    const headItem = head.items.find((i) => i.unit.id === 'deep');
    expect(headItem?.terms).toEqual([]);
    expect(headItem?.score).toBe(0);
    const full = await service.search('needle', { fullText: true, limit: 10 });
    const fullItem = full.items.find((i) => i.unit.id === 'deep');
    expect(fullItem?.terms).toContain('needle');
    expect(fullItem!.score).toBeGreaterThan(0);
  });
});

describe('search pagination', () => {
  const units: Unit[] = [
    makeUnit({ id: 'p1', title: 'Postgres vacuum settings', summary: 'a', body: 'body' }),
    makeUnit({ id: 'p2', title: 'Postgres index tuning', summary: 'b', body: 'body' }),
    makeUnit({ id: 'p3', title: 'Postgres replication notes', summary: 'c', body: 'body' }),
    makeUnit({ id: 'p4', title: 'Postgres backup strategy', summary: 'd', body: 'body' }),
    makeUnit({ id: 'p5', title: 'Postgres extensions guide', summary: 'e', body: 'body' }),
  ];

  it('returns total and pages through results with offset', async () => {
    const { service } = await seededService(units);
    const page1 = await service.search('postgres', { limit: 2 });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    const page2 = await service.search('postgres', { limit: 2, offset: 2 });
    expect(page2.total).toBe(5);
    expect(page2.items).toHaveLength(2);
    const ids = [...page1.items, ...page2.items].map((i) => i.unit.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('returns an empty page past the end without error', async () => {
    const { service } = await seededService(units);
    const last = await service.search('postgres', { limit: 2, offset: 10 });
    expect(last.items).toHaveLength(0);
    expect(last.total).toBe(5);
  });
});
