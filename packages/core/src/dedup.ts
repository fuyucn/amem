import type { Embedding, Unit } from './domain.js';
import { cosine } from './lib/vector.js';

/** A candidate that carries its embedding for similarity comparison. */
export interface EmbeddableCandidate {
  title: string;
  embedding: Embedding;
}

export interface DuplicateMatch {
  unit: Unit;
  similarity: number;
}

/**
 * Normalize text for cheap exact-match dedup (mirrors TencentDB l1-dedup's
 * normalized-text pre-filter). Lowercases, collapses whitespace, and drops
 * punctuation so "Use DeepSeek!" and "use deepseek" collide.
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

/**
 * Find the existing unit most similar to the candidate, if any passes the
 * threshold. Pure and deterministic.
 *
 * Two-stage matching for accuracy:
 * 1. Normalized-text exact match on title (length >= 6 chars) — a strong
 *    signal that the same knowledge was distilled again, no embedding needed.
 * 2. Embedding cosine similarity above `threshold`.
 */
export function findDuplicate(
  candidate: EmbeddableCandidate,
  existing: Unit[],
  threshold: number,
): DuplicateMatch | null {
  const norm = normalizeText(candidate.title);
  if (norm.length >= 6) {
    for (const unit of existing) {
      if (unit.status === 'merged' || unit.status === 'archived') continue;
      if (normalizeText(unit.title) === norm) {
        return { unit, similarity: 1 };
      }
    }
  }
  let best: DuplicateMatch | null = null;
  for (const unit of existing) {
    if (!unit.embedding) continue;
    const sim = cosine(candidate.embedding.values, unit.embedding.values);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { unit, similarity: sim };
    }
  }
  return best;
}

/** Shape of the merge source: new knowledge to fold into an existing unit. */
export interface MergeSource {
  summary: string;
  body: string;
  quality: number;
}

/** Merge a candidate into an existing unit: append body, refresh summary, bump quality. */
export function mergeUnits(existing: Unit, candidate: MergeSource): Unit {
  const body = candidate.body
    ? existing.body ? `${existing.body}\n\n${candidate.body}` : candidate.body
    : existing.body;
  return {
    ...existing,
    body,
    summary: existing.summary || candidate.summary,
    quality: Math.min(1, existing.quality + (1 - existing.quality) * 0.1),
    version: existing.version + 1,
    updatedAt: new Date().toISOString(),
  };
}
