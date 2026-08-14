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

/** Token-level overlap stats between two titles (Jaccard + longest shared token). */
export function titleTokenOverlap(
  a: string,
  b: string,
): { jaccard: number; longestShared: number } {
  const ta = new Set(normalizeText(a).split(/\s+/).filter(Boolean));
  const tb = new Set(normalizeText(b).split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return { jaccard: 0, longestShared: 0 };
  let shared = 0;
  let longest = 0;
  for (const t of ta) {
    if (tb.has(t)) {
      shared++;
      if (t.length > longest) longest = t.length;
    }
  }
  return { jaccard: shared / (ta.size + tb.size - shared), longestShared: longest };
}

/**
 * Hard gate for embedding-based dedup: two titles must share real words.
 * The offline hash embedder is a coarse projection, so cosine alone can
 * falsely merge unrelated texts; requiring lexical overlap keeps merges on
 * the same topic while still allowing paraphrase-heavy matches.
 */
export function hasTokenOverlap(a: string, b: string, minTokenLength = 4, minJaccard = 0.3): boolean {
  const { jaccard, longestShared } = titleTokenOverlap(a, b);
  return jaccard >= minJaccard || longestShared >= minTokenLength;
}

/**
 * Find the existing unit most similar to the candidate, if any passes the
 * threshold. Pure and deterministic.
 *
 * Two-stage matching for accuracy:
 * 1. Normalized-text exact match on title (length >= 6 chars) — a strong
 *    signal that the same knowledge was distilled again, no embedding needed.
 * 2. Embedding cosine similarity above `threshold` AND lexical token overlap
 *    (see hasTokenOverlap) so unrelated high-cosine texts are never merged.
 */
export function findDuplicate(
  candidate: EmbeddableCandidate,
  existing: Unit[],
  threshold: number,
  opts: { minTokenLength?: number; minJaccard?: number } = {},
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
    if (
      sim >= threshold &&
      hasTokenOverlap(candidate.title, unit.title, opts.minTokenLength, opts.minJaccard) &&
      (!best || sim > best.similarity)
    ) {
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
