import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  importCodebase,
  importDirectory,
  importSessions,
  type ImporterDeps,
} from '../src/index.js';
import { FakeStorage, makeUnit } from './helpers.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'amem-import-'));
}

function deps(storage: FakeStorage): ImporterDeps {
  return {
    storage,
    ingest: async (input) => {
      const trace = {
        id: `trace_${Math.random().toString(36).slice(2)}`,
        title: input.title,
        content: input.content,
        contentType: input.contentType ?? 'text/markdown',
        tokenCount: input.content.length,
        createdAt: new Date().toISOString(),
      };
      await storage.createTrace(trace);
      const unit = makeUnit({
        id: `unit_${Math.random().toString(36).slice(2)}`,
        title: input.title,
        summary: input.content.slice(0, 80),
        body: input.content,
        status: 'reviewed',
      });
      await storage.createUnit(unit);
      return { trace, units: [unit], deduplicated: [], tokensSavedByDedup: 0 };
    },
    saveUnit: async (u) => {
      const unit = makeUnit(u as Parameters<typeof makeUnit>[0]);
      await storage.createUnit(unit);
      return unit;
    },
    linkUnits: async (l) => {
      const link = {
        id: `link_${Math.random().toString(36).slice(2)}`,
        sourceUnitId: l.sourceUnitId,
        targetUnitId: l.targetUnitId,
        relation: l.relation,
        reason: l.reason ?? 'test',
        confidence: 1,
        auto: true,
        createdAt: new Date().toISOString(),
      };
      await storage.createLink(link);
      return link;
    },
  };
}

describe('importDirectory', () => {
  it('ingests markdown files and reports counts', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a.md'), '# Hello\n\nSome doc content here.');
    await writeFile(join(dir, 'b.md'), 'Plain notes too.');
    try {
      const storage = new FakeStorage();
      const result = await importDirectory(deps(storage), { path: dir });
      expect(result.files).toBe(2);
      expect(result.traces).toBe(2);
      expect(result.units).toBeGreaterThanOrEqual(2);
      expect(storage.traces.size).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('importCodebase', () => {
  it('extracts modules + symbols with stable ids and part_of links', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'greet.ts'), 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n\nexport class Greeter {}\n');
    try {
      const storage = new FakeStorage();
      const result = await importCodebase(deps(storage), { path: dir });
      expect(result.files).toBe(1);
      expect(result.units).toBeGreaterThanOrEqual(3); // module + function + class
      expect(result.links).toBeGreaterThanOrEqual(2); // part_of for each symbol
      const units = [...storage.units.values()];
      expect(units.some((u) => u.title.includes('Module:'))).toBe(true);
      expect(units.some((u) => u.title.includes('function: greet'))).toBe(true);
      const partOf = [...storage.links.values()].filter((l) => l.relation === 'part_of');
      expect(partOf.length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: re-import produces the same unit ids', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'x.py'), 'def helper():\n    pass\n');
    try {
      const storage = new FakeStorage();
      const first = await importCodebase(deps(storage), { path: dir });
      const ids = new Set([...storage.units.keys()]);
      const second = await importCodebase(deps(storage), { path: dir });
      expect(second.files).toBe(1);
      // Same ids -> createUnit overwrites instead of duplicating.
      expect([...storage.units.keys()].every((id) => ids.has(id))).toBe(true);
      expect(storage.units.size).toBe(first.units);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('importSessions', () => {
  it('parses JSONL agent transcripts into traces + units', async () => {
    const dir = await tempDir();
    const lines = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'How do I set up auth?' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'Use OAuth with PKCE.\n\nKey decision: PKCE.' } }),
    ].join('\n');
    await writeFile(join(dir, 'session.jsonl'), lines);
    try {
      const storage = new FakeStorage();
      const result = await importSessions(deps(storage), { path: dir });
      expect(result.sessions).toBe(1);
      expect(result.traces).toBe(1);
      expect(result.units).toBeGreaterThanOrEqual(1);
      const trace = [...storage.traces.values()][0];
      expect(trace.content).toContain('OAuth with PKCE');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses plain-text transcripts with role prefixes', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'chat.txt'), 'user: what is the deploy flow?\nassistant: run pnpm build then docker compose up.\n');
    try {
      const storage = new FakeStorage();
      const result = await importSessions(deps(storage), { path: join(dir, 'chat.txt') });
      expect(result.traces).toBe(1);
      expect([...storage.traces.values()][0].content).toContain('docker compose up');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
