export const DEFAULT_EMBEDDING_DIMS = 64;

/** Cosine similarity of two equal-ish vectors. Zero-safe. */
export function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** L2-normalize a vector. Returns a zero vector when magnitude is 0. */
export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const mag = Math.sqrt(sum);
  if (mag === 0) return v.map(() => 0);
  return v.map((x) => x / mag);
}

/**
 * Deterministic, stable hash-based embedding. Same text always yields the same
 * vector for a given dims, so offline mode is reproducible across calls.
 */
export function hashEmbed(text: string, dims: number): number[] {
  const out: number[] = new Array(dims);
  for (let d = 0; d < dims; d++) {
    const token = `${text}\u0000${d}`;
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    out[d] = ((h >>> 0) / 0xffffffff) * 2 - 1;
  }
  return out;
}
