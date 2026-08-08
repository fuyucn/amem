const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/**
 * A deterministic approximate token counter. Each CJK character counts as one
 * token; other text is split into words and counted at ~4 chars per token.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE);
  let total = cjk ? cjk.length : 0;
  const nonCjk = text.replace(CJK_RE, ' ');
  for (const word of nonCjk.split(/\s+/)) {
    if (word.length === 0) continue;
    total += Math.max(1, Math.ceil(word.length / 4));
  }
  return total;
}
