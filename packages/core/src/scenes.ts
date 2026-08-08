/**
 * Scene continuity (TencentDB-Agent-Memory scene semantics, SQLite-flavored).
 *
 * A "scene" is a topic-consistent segment of a conversation. Amem stores
 * scenes as L2 scenarios carrying a `heat` counter (recall hits). This module:
 *   1. segments a transcript into topic-shifted scenes (deterministic, offline),
 *   2. upserts them into `scenarios` (create / update / merge at the cap),
 *   3. lets layered recall navigate by heat and bump it on hits.
 *
 * Scene heat gives agents the "hot scenes first" navigation Tencent ships in
 * persona.md — without the file-based scene blocks, which don't fit SQLite.
 */
import type { AmemConfig, SceneExtractReport, Scenario } from './domain.js';
import type { Storage } from './store.js';
import { newId, nowIso } from './lib/util.js';

export interface SceneSegment {
  title: string;
  summary: string;
  content: string;
  tags: string[];
  turnCount: number;
}

export interface SceneOptions {
  /** hard cap on active scenes; beyond it new scenes merge into similar ones. */
  maxScenes?: number;
  /** keyword overlap ratio required to treat an existing scene as the same one. */
  matchThreshold?: number;
  /** topic-shift threshold: below this overlap a new scene starts. */
  shiftThreshold?: number;
  /** max turns per scene before a hard split. */
  maxTurnsPerScene?: number;
}

const ROLE_RE = /^(user|assistant|system|tool|human|model)\s*[:：\-–—]\s*/i;

const STOP = new Set([
  'about', 'their', 'there', 'these', 'those', 'which', 'would', 'could',
  'should', 'after', 'before', 'using', 'with', 'them', 'then', 'than',
  'that', 'this', 'have', 'from', 'what', 'were', 'will', 'your', 'into',
  'more', 'some', 'been', 'when', 'where', 'also', 'just', 'like', 'know',
]);

export function sceneKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _\-./]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOP.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([w]) => w);
}

function overlap(a: string[], b: string[]): number {
  if (b.length === 0) return 0;
  const setA = new Set(a);
  let hits = 0;
  for (const t of b) if (setA.has(t)) hits++;
  return hits / b.length;
}

function splitTurns(rawText: string): Array<{ role: string; text: string }> {
  const lines = rawText.split(/\r?\n/);
  const turns: Array<{ role: string; text: string }> = [];
  let cur: { role: string; text: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^(user|assistant|system|tool|human|model)\s*[:：\-–—]\s*(.*)$/i);
    if (m) {
      if (cur) turns.push(cur);
      cur = { role: m[1]!.toLowerCase(), text: m[2]!.trim() };
    } else if (cur) {
      cur.text = `${cur.text}\n${line}`.trim();
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function segmentTitle(turns: Array<{ role: string; text: string }>): string {
  const joined = turns.map((t) => t.text).join(' ');
  const kws = sceneKeywords(joined);
  const kwTitle = kws.slice(0, 3).join(' ');
  if (kwTitle.length >= 8) {
    const t = kwTitle.charAt(0).toUpperCase() + kwTitle.slice(1);
    return t.slice(0, 80);
  }
  const first = collapse(turns[0]?.text ?? '');
  const clause = first.split(/(?<=[.!?。！？])\s+|;\s+/)[0] ?? first;
  const title = clause.replace(/[^\p{L}\p{N} _\-./]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 10).join(' ');
  return (title || 'Conversation scene').slice(0, 80);
}

function segmentContent(turns: Array<{ role: string; text: string }>): string {
  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const t of turns) {
    const line = collapse(t.text);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    bullets.push(`- ${line.slice(0, 400)}`);
  }
  return bullets.join('\n').slice(0, 2000);
}

/**
 * Segment a transcript into topic-consistent scenes.
 *
 * Deterministic and offline-safe: consecutive turns stay in the same scene
 * until the keyword overlap between them drops below `shiftThreshold`, or a
 * scene reaches `maxTurnsPerScene` turns (hard split). Pure function — no I/O.
 */
export function segmentTranscript(rawText: string, opts: SceneOptions = {}): SceneSegment[] {
  const shiftThreshold = opts.shiftThreshold ?? 0.15;
  const maxTurnsPerScene = opts.maxTurnsPerScene ?? 6;
  const turns = splitTurns(rawText);
  const groups: Array<Array<{ role: string; text: string }>> = [];
  let cur: Array<{ role: string; text: string }> = [];

  for (const turn of turns) {
    if (!turn.text.trim()) continue;
    if (cur.length === 0) {
      cur.push(turn);
      continue;
    }
    const prev = cur[cur.length - 1]!;
    const shift = overlap(sceneKeywords(prev.text), sceneKeywords(turn.text));
    if (shift < shiftThreshold || cur.length >= maxTurnsPerScene) {
      groups.push(cur);
      cur = [turn];
    } else {
      cur.push(turn);
    }
  }
  if (cur.length > 0) groups.push(cur);

  return groups.map((g) => {
    const joined = g.map((t) => t.text).join(' ');
    const tags = [...new Set([...sceneKeywords(joined).slice(0, 5), 'scene'])];
    return {
      title: segmentTitle(g),
      summary: collapse(joined).slice(0, 160),
      content: segmentContent(g),
      tags,
      turnCount: g.length,
    };
  });
}

export function mergeContent(existing: string, fresh: string): string {
  const base = existing.trim();
  const add = fresh.trim();
  if (!add) return base;
  if (!base) return add;
  const seen = new Set(base.split('\n').map((l) => l.trim()));
  const extra = add
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !seen.has(l));
  if (extra.length === 0) return base;
  return `${base}\n${extra.join('\n')}`.slice(0, 3000);
}

function scenarioTerms(s: Scenario): string[] {
  return sceneKeywords([s.title, s.summary, ...(s.tags ?? [])].join(' '));
}

/**
 * Upsert scene segments into L2 scenarios with Tencent-style heat:
 * - strong match  -> update in place, bump heat, fold content in;
 * - no match      -> create (heat 1);
 * - over the cap  -> merge into the most similar scene (tie: lowest heat).
 */
export async function upsertScenes(
  storage: Storage,
  config: AmemConfig,
  segments: SceneSegment[],
  opts: SceneOptions = {},
): Promise<SceneExtractReport> {
  const maxScenes = opts.maxScenes ?? config.thresholds.maxScenarios ?? 12;
  const matchThreshold = opts.matchThreshold ?? 0.4;
  const report: SceneExtractReport = {
    segments: segments.length,
    scenesCreated: 0,
    scenesUpdated: 0,
    scenesMerged: 0,
    touchedTitles: [],
  };
  if (segments.length === 0) return report;

  const existing = await storage.listScenarios({ status: 'active', limit: 200 });

  for (const seg of segments) {
    const segTerms = sceneKeywords([seg.title, seg.summary, ...seg.tags].join(' '));
    if (segTerms.length === 0) continue;
    let best: Scenario | null = null;
    let bestScore = 0;
    for (const s of existing) {
      const score = overlap(scenarioTerms(s), segTerms);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    const now = nowIso();
    if (best && bestScore >= matchThreshold) {
      const updated: Scenario = {
        ...best,
        summary: best.summary || seg.summary,
        content: mergeContent(best.content, seg.content),
        tags: [...new Set([...(best.tags ?? []), ...seg.tags])].slice(0, 8),
        heat: (best.heat ?? 0) + 1,
        lastHitAt: now,
        updatedAt: now,
      };
      await storage.updateScenario(updated);
      report.scenesUpdated++;
      report.touchedTitles.push(updated.title);
      continue;
    }
    if (existing.length >= maxScenes) {
      const target =
        best ?? [...existing].sort((a, b) => (a.heat ?? 0) - (b.heat ?? 0))[0]!;
      const merged: Scenario = {
        ...target,
        content: mergeContent(target.content, seg.content),
        tags: [...new Set([...(target.tags ?? []), ...seg.tags])].slice(0, 8),
        heat: (target.heat ?? 0) + 1,
        lastHitAt: now,
        updatedAt: now,
      };
      await storage.updateScenario(merged);
      report.scenesMerged++;
      report.touchedTitles.push(merged.title);
      continue;
    }
    const created: Scenario = {
      id: newId('scn'),
      title: seg.title,
      summary: seg.summary,
      content: seg.content,
      tags: seg.tags,
      sourceUnitIds: [],
      status: 'active',
      version: 1,
      heat: 1,
      lastHitAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await storage.createScenario(created);
    existing.push(created);
    report.scenesCreated++;
    report.touchedTitles.push(created.title);
  }

  await storage
    .recordEvent({
      kind: 'scene_extract',
      summary: `Scenes: +${report.scenesCreated} created, ${report.scenesUpdated} updated, ${report.scenesMerged} merged (${report.segments} segment(s))`,
      meta: { ...report },
    })
    .catch(() => {});
  return report;
}

/** Segment + upsert in one call (used by the ingest path). */
export async function extractScenesFromTranscript(
  storage: Storage,
  config: AmemConfig,
  rawText: string,
  opts: SceneOptions = {},
): Promise<SceneExtractReport> {
  const segments = segmentTranscript(rawText, opts);
  return upsertScenes(storage, config, segments, opts);
}
