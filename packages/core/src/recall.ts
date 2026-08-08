import type {
  AmemConfig,
  ContextItem,
  RecallInput,
  RecallResult,
  Source,
  Unit,
  UnitType,
  UnitSummary,
} from './domain.js';
import type { Storage } from './store.js';
import type { Embedder } from './embedder.js';
import { isCodeSymbolUnit } from './classify.js';
import { cosine } from './lib/vector.js';
import { countTokens } from './lib/tokenizer.js';
import { isNearDuplicateOf } from './lib/recallSelect.js';
import { recencyScore, toUnitSummary } from './lib/util.js';

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'did', 'was']);
/** Code-flavoured queries keep code-symbol units relevant (no demotion). */
const CODE_QUERY_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|rb|php|sh|sql|json|ya?ml)\b|\b(function|class|interface|module|import|export|const|let|var|def|func|fn|type|enum|struct|impl|api|route|endpoint|schema|component|hook)\b/i;
const KNOWLEDGE_TYPES: ReadonlySet<UnitType> = new Set([
  'procedure',
  'decision',
  'lesson',
  'plan',
  'preference',
  'concept',
]);

interface Scored {
  unit: Unit;
  score: number;
  reason: string;
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function keywordOverlap(query: string, unit: Unit): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const haystack = [unit.title, unit.summary, ...unit.tags, unit.body.slice(0, 400)]
    .join(' ')
    .toLowerCase();
  let hits = 0;
  for (const t of terms) if (haystack.includes(t)) hits++;
  return hits / terms.length;
}

/** Natural-language query => demote auto-extracted code symbols, boost knowledge units. */
export function codeSymbolAdjustment(
  unit: Unit,
  query: string,
  config: AmemConfig,
): { delta: number; reason?: string } {
  if (CODE_QUERY_RE.test(query)) return { delta: 0 };
  if (isCodeSymbolUnit(unit)) {
    return { delta: -config.thresholds.codeSymbolPenalty, reason: 'code-symbol' };
  }
  if (KNOWLEDGE_TYPES.has(unit.type)) {
    return { delta: config.thresholds.knowledgeBoost, reason: 'knowledge' };
  }
  return { delta: 0 };
}

function buildBlock(unit: UnitSummary, body: string | undefined, sources: Source[]): string {
  const lines: string[] = [`[unit:${unit.title}](#${unit.id})`];
  if (unit.summary) lines.push(unit.summary);
  if (body) lines.push(body);
  if (sources.length > 0) lines.push(`Source: ${sources.map((s) => s.title).join(', ')}`);
  return lines.join('\n');
}

/** Hybrid semantic + keyword + recency/decay/importance recall with token budgeting. */
export async function recall(
  storage: Storage,
  embed: Embedder,
  config: AmemConfig,
  input: RecallInput,
): Promise<RecallResult> {
  const budget = input.tokenBudget ?? config.thresholds.recallBudget;
  const topK = input.topK ?? 10;
  const queryVec = await embed.embed(input.query);
  const all = await storage.allUnitsWithEmbeddings();

  const scored: Scored[] = [];
  for (const unit of all) {
    if (unit.status === 'archived') continue;
    const reasons: string[] = [];
    let score = 0;
    if (unit.embedding) {
      const sim = cosine(queryVec, unit.embedding.values);
      score += sim * 0.5;
      if (sim > 0.01) reasons.push(`semantic ${sim.toFixed(2)}`);
    }
    const kw = keywordOverlap(input.query, unit);
    score += kw * 0.3;
    if (kw > 0) reasons.push(`keyword ${kw.toFixed(2)}`);
    if (unit.status === 'pending') {
      score -= 0.12; // unreviewed extraction: correct but less trusted
      reasons.push('pending');
    }
    score += recencyScore(unit.updatedAt) * 0.1;
    score += unit.decay * 0.05;
    score += unit.importance * 0.05;
    const adjust = codeSymbolAdjustment(unit, input.query, config);
    score += adjust.delta;
    if (adjust.reason) reasons.push(adjust.reason);
    scored.push({ unit, score: Math.max(0, score), reason: reasons.join(', ') || 'baseline' });
  }
  scored.sort((a, b) => b.score - a.score);
  // Accuracy guard: suppress near-duplicates of an already-accepted unit so
  // the agent sees one canonical block per fact instead of N paraphrases.
  const accepted: Array<{ unit: Unit; score: number }> = [];
  let deduplicated = 0;
  const top: typeof scored = [];
  for (const s of scored) {
    if (accepted.some((a) => isNearDuplicateOf(s.unit, a.unit))) {
      deduplicated++;
      continue;
    }
    accepted.push(s);
    top.push(s);
    if (top.length >= topK) break;
  }

  const items: ContextItem[] = [];
  const textParts: string[] = [];
  let used = 0;
  let grounded = false;

  for (const { unit, score, reason } of top) {
    const sourceIds = await storage.distinctSourceIdsForUnit(unit.id);
    const sources = sourceIds.length > 0 ? await storage.sourcesByIds(sourceIds) : [];
    const block = buildBlock(
      toUnitSummary(unit),
      input.includeBody ? unit.body : undefined,
      sources,
    );
    const tokens = countTokens(block);
    if (used + tokens > budget) break;
    used += tokens;
    textParts.push(block);
    if (sources.length > 0) grounded = true;
    items.push({ unit: toUnitSummary(unit), score, reason, citations: sources });
  }

  return {
    query: input.query,
    budget,
    usedTokens: used,
    items,
    text: textParts.join('\n\n'),
    grounded,
    deduplicated,
  };
}
