/**
 * Recall selection helpers shared by recall / layeredRecall.
 *
 * Near-duplicate detection keeps the agent's context honest: one canonical
 * block per fact instead of N paraphrases of the same knowledge (token
 * savings + fewer contradictions for the caller).
 */
import type { Unit } from '../domain.js';
import { cosine } from './vector.js';
import { normalizeText } from '../dedup.js';

export const NEAR_DUPLICATE_COSINE = 0.92;

/** A second unit is a near-duplicate when its title normalizes identically or
 * its embedding is almost the same. Pure and deterministic. */
export function isNearDuplicateOf(candidate: Unit, accepted: Unit): boolean {
  const normTitle = normalizeText(candidate.title);
  if (normTitle.length >= 6 && normTitle === normalizeText(accepted.title)) return true;
  if (candidate.embedding && accepted.embedding) {
    return cosine(candidate.embedding.values, accepted.embedding.values) >= NEAR_DUPLICATE_COSINE;
  }
  return false;
}
