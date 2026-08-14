export const DEFAULT_EMBEDDING_DIMS = 64;

/** How much of a unit's body is hashed for retrieval (matches the keyword
 *  haystack head so semantic and keyword signals agree). */
export const EMBED_BODY_HEAD = 400;

/** Title-dominant composition weights for unit embeddings. A unit's identity
 *  lives in its title/summary; the (often long) body dilutes shared tokens and
 *  makes same-family units indistinguishable (e.g. code interfaces in one
 *  file). Hash each part separately, weight, then L2-normalize. */
export const EMBED_WEIGHTS = { title: 3, summary: 2, body: 1 } as const;

function zeroVec(dims: number): number[] {
  return new Array<number>(dims).fill(0);
}

/** Hash a unit into a weighted title/summary/body-head vector. Deterministic;
 *  used by ingest and reembed so stored embeddings stay comparable. */
export function hashUnitEmbed(
  opts: { title: string; summary?: string; body?: string },
  dims: number,
): number[] {
  const t = hashEmbed(opts.title, dims);
  const s = opts.summary ? hashEmbed(opts.summary, dims) : zeroVec(dims);
  const head = (opts.body ?? '').slice(0, EMBED_BODY_HEAD);
  const h = head ? hashEmbed(head, dims) : zeroVec(dims);
  const w = EMBED_WEIGHTS;
  return normalize(t.map((x, i) => x * w.title + (s[i] ?? 0) * w.summary + (h[i] ?? 0) * w.body));
}

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

/** FNV-1a 32-bit hash. Deterministic across runs and platforms. */
function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Tokenize mixed Latin/CJK text into retrieval features:
 * - Latin words/identifiers split on `_` and camelCase boundaries, lowercased
 *   (so `hashEmbed` / `AMEM_OCR_BASE_URL` stay recallable by part);
 * - CJK runs become single chars + character bigrams, so short Chinese
 *   queries still match without a word segmenter.
 */
export function tokenizeForEmbedding(text: string): string[] {
  const tokens: string[] = [];
  const latin = text.match(/[A-Za-z0-9_]+/g) ?? [];
  for (const word of latin) {
    const parts = word
      .split(/(?<=[a-z0-9])(?=[A-Z])|_+/g)
      .map((p) => p.toLowerCase())
      .filter(Boolean);
    for (const p of parts) tokens.push(p);
  }
  const cjk = text.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]!);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/**
 * Deterministic, stable hash-based embedding (signed feature hashing).
 * Same text always yields the same vector for a given dims, so offline mode
 * is reproducible across calls. Unlike the old whole-text FNV digest (which
 * was length-sensitive and made long queries near-orthogonal to their own
 * source text), this sums per-token buckets with sublinear TF weights, so
 * texts sharing words/characters get a high cosine similarity while
 * unrelated texts stay near-zero. Output is L2-normalized.
 */
export function hashEmbed(text: string, dims: number): number[] {
  if (dims <= 0) return [];
  const out = new Array<number>(dims).fill(0);
  const counts = new Map<string, number>();
  for (const token of tokenizeForEmbedding(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of counts) {
    const bucket = fnv1a(token) % dims;
    // Second seed picks the sign so bucket collisions cancel out on average.
    const sign = (fnv1a(token, 0x9747b28c) & 1) === 0 ? 1 : -1;
    // Sublinear TF: repetition helps, but never dominates the vector.
    const weight = 1 + Math.log2(count);
    out[bucket] = (out[bucket] ?? 0) + sign * weight;
  }
  return normalize(out);
}
