#!/usr/bin/env node
/**
 * Benchmark consolidation + link generation against a copy of a real store.
 *
 * Measures wall time, the number of storage round-trips (N+1 check), how many
 * units the maintenance pass rewrites (dirty-write check), and how much
 * embedding payload link generation has to load (bounded vs full scan).
 *
 * Usage:
 *   node tools/bench-consolidate.mjs [path-to-amem.db]
 */
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStorageFromPath } from '../packages/db/dist/index.js';
import {
  DEFAULT_CONFIG,
  OfflineEmbedder,
  consolidate,
  generateLinks,
} from '../packages/core/dist/index.js';

const src = process.argv[2] || 'data/amem.db';
const dir = mkdtempSync(join(tmpdir(), 'amem-bench-'));
const dbPath = join(dir, 'bench.db');
copyFileSync(src, dbPath);

const storage = await createSqliteStorageFromPath(dbPath);
const counts = await storage.counts();
console.log(`store: ${JSON.stringify(counts)}`);

const embed = new OfflineEmbedder(64);
const config = { ...DEFAULT_CONFIG };

// --- instrumentation: count storage round-trips per phase ---
const tracked = [
  'allUnits',
  'allUnitsWithEmbeddings',
  'allLinks',
  'createLink',
  'createLinks',
  'deleteLink',
  'deleteLinks',
  'updateUnits',
  'sourceCountsByUnit',
  'recordJob',
  'markJob',
];
function instrument(phase) {
  for (const key of tracked) {
    const orig = storage[key].bind(storage);
    storage[key] = async (...args) => {
      phase.calls[key] = (phase.calls[key] ?? 0) + 1;
      if (key === 'updateUnits') {
        phase.rowsWritten = (phase.rowsWritten ?? 0) + (args[0]?.length ?? 0);
      }
      return orig(...args);
    };
  }
}

function report(name, ms, phase, extra = {}) {
  const calls = Object.entries(phase.calls)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join(', ');
  const rows = phase.rowsWritten !== undefined ? `, rowsWritten=${phase.rowsWritten}` : '';
  console.log(
    `- ${name}: ${ms.toFixed(1)}ms  [${calls}${rows}]${extra ? '  ' + JSON.stringify(extra) : ''}`,
  );
}

// S1: maintenance pass without link generation (light read + batch write).
{
  const phase = { calls: {} };
  instrument(phase);
  const t0 = performance.now();
  const report1 = await consolidate(storage, config, undefined, { skipLinks: true });
  const ms = performance.now() - t0;
  report('consolidate (skipLinks)', ms, phase, {
    promoted: report1.crystalsPromoted,
    archived: report1.archived,
    pruned: report1.linksPruned,
  });
}

// S1b: idempotent re-run — proves the dirty-write check (nothing to write).
{
  const phase = { calls: {} };
  instrument(phase);
  const t0 = performance.now();
  await consolidate(storage, config, undefined, { skipLinks: true });
  const ms = performance.now() - t0;
  report('consolidate (skipLinks, idempotent re-run)', ms, phase);
}

// S2: full maintenance pass including link generation (batch link inserts).
{
  const phase = { calls: {} };
  instrument(phase);
  const t0 = performance.now();
  const report2 = await consolidate(storage, config, embed, {});
  const ms = performance.now() - t0;
  report('consolidate (with linkgen)', ms, phase, { linksCreated: report2.linksCreated });
}

// S3: link generation alone — quantifies the embedding payload loaded by the
// bounded query versus an unbounded full scan.
{
  const rowsAll = await storage.allUnitsWithEmbeddings();
  const rowsCapped = await storage.allUnitsWithEmbeddings(500);
  const bytesOf = (rows) =>
    rows.reduce(
      (acc, u) => acc + (u.embedding ? u.embedding.values.length * 4 : 0),
      0,
    );
  console.log(
    `- linkgen embedding payload: bounded=500 rows (${(bytesOf(rowsCapped) / 1024).toFixed(1)} KiB) ` +
      `vs full scan ${rowsAll.length} rows (${(bytesOf(rowsAll) / 1024).toFixed(1)} KiB)`,
  );

  const phase = { calls: {} };
  instrument(phase);
  const t0 = performance.now();
await generateLinks(storage, embed, config);
const ms = performance.now() - t0;
report('generateLinks (idempotent re-run)', ms, phase);
}

// S4: scaling — synthetic 3k-unit store shows the bounded embedding load.
{
  const dir2 = mkdtempSync(join(tmpdir(), 'amem-bench-scale-'));
  const scale = await createSqliteStorageFromPath(join(dir2, 'scale.db'));
  const N = 3000;
  const dims = 768; // realistic production embedding dimension
  for (let i = 0; i < N; i++) {
    const values = new Array(dims).fill(0).map((_, j) => Math.sin(i * 0.01 + j));
    await scale.createUnit({
      id: `scale-${i}`,
      type: 'fact',
      form: 'unit',
      title: `Scaled unit ${i}`,
      summary: 'synthetic',
      body: '',
      tags: ['bench'],
      labels: {},
      status: 'reviewed',
      quality: 0.5,
      confidence: 0.5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() - i * 1000).toISOString(),
      sourceCount: 0,
      importance: 0.5,
      decay: 1,
      version: 1,
      embedding: { dims, values },
    });
  }
  const rowsAll = await scale.allUnitsWithEmbeddings();
  const rowsCapped = await scale.allUnitsWithEmbeddings(500);
  const bytesOf = (rows) =>
    rows.reduce((acc, u) => acc + (u.embedding ? u.embedding.values.length * 4 : 0), 0);
  const t0 = performance.now();
  await scale.allUnitsWithEmbeddings();
  const fullMs = performance.now() - t0;
  const t1 = performance.now();
  await scale.allUnitsWithEmbeddings(500);
  const cappedMs = performance.now() - t1;
  console.log(
    `- scaling (${N} units × ${dims}d): full scan loads ${rowsAll.length} rows ` +
      `(${(bytesOf(rowsAll) / 1024 / 1024).toFixed(1)} MiB, ${fullMs.toFixed(1)}ms) vs ` +
      `bounded 500 rows (${(bytesOf(rowsCapped) / 1024 / 1024).toFixed(1)} MiB, ` +
      `${cappedMs.toFixed(1)}ms) — payload cut ${(
        (1 - bytesOf(rowsCapped) / bytesOf(rowsAll)) * 100
      ).toFixed(1)}%`,
  );
  await scale.close();
}

await storage.close();
console.log(`bench db: ${dbPath}`);
