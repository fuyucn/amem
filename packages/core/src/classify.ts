import type { LlmClient } from './llm.js';
import type { Unit, UnitType } from './domain.js';

/**
 * Knowledge-unit classification (category taxonomy).
 *
 * Categories are stored on `unit.labels.category` and drive the Units
 * management console, graph coloring, and workspace organization. The rule
 * classifier is deterministic and offline; an optional LLM pass refines it
 * when a provider is configured.
 */
export const UNIT_CATEGORIES = [
  'code',
  'infra',
  'workflow',
  'product',
  'personal',
  'research',
  'meta',
  'other',
] as const;
export type UnitCategory = (typeof UNIT_CATEGORIES)[number];

/** LLM intent marker so MockLlmClient/test doubles can key on classification. */
export const LLM_CLASSIFY_INTENT = 'categorize each knowledge unit';

const CODE_SYMBOL_KINDS = new Set(['module', 'symbol', 'function', 'class', 'interface', 'type', 'variable', 'constant', 'enum']);
const CODE_PREFIX_RE = /^(module|function|class|interface|type|const|enum|variable|symbol)\b[\s:：]/i;
const INFRA_RE = /\b(docker|compose|kubernetes|k8s|deploy|nginx|env|config|migration|postgres|sqlite|redis|proxy|vpn|tailscale|cicd|ci\/cd)\b/i;
const WORKFLOW_RE = /\b(setup|install|how to|how-to|run|command|recipe|guide|script|onboarding|workflow)\b/i;
const PRODUCT_RE = /\b(product|feature|roadmap|requirement|user story|pricing|customer|market)\b/i;
const META_RE = /\b(amem|knowledge base|knowledge graph|memory system|mcp|workspace)\b/i;

export interface ClassifiableUnit {
  type: UnitType;
  title: string;
  tags: string[];
  labels: Record<string, string | number | boolean>;
}

/** True for auto-extracted code-symbol units (module/function/class/...). */
export function isCodeSymbolUnit(unit: Pick<Unit, 'title' | 'labels'>): boolean {
  const symbolKind = String(unit.labels?.symbolKind ?? '');
  const kind = String(unit.labels?.kind ?? '');
  if (symbolKind && CODE_SYMBOL_KINDS.has(symbolKind)) return true;
  if (kind === 'module' || kind === 'symbol') return true;
  if (CODE_PREFIX_RE.test(unit.title.trim())) return true;
  return false;
}

/**
 * Deterministic offline classifier. Order matters: code symbols first, then
 * explicit unit types, then keyword signals, then the meta/other fallback.
 */
export function classifyUnitRuleBased(unit: ClassifiableUnit): UnitCategory {
  if (isCodeSymbolUnit(unit)) return 'code';

  switch (unit.type) {
    case 'procedure':
      return 'workflow';
    case 'preference':
      return 'personal';
    case 'question':
      return 'research';
    case 'lesson':
      return 'research';
    case 'decision':
    case 'plan':
      return 'product';
    default:
      break;
  }

  const hay = `${unit.title} ${unit.tags.join(' ')}`;
  if (INFRA_RE.test(hay)) return 'infra';
  if (WORKFLOW_RE.test(hay)) return 'workflow';
  if (PRODUCT_RE.test(hay)) return 'product';
  if (META_RE.test(hay)) return 'meta';
  return 'other';
}

export interface ClassifyOutcome {
  category: UnitCategory;
  via: 'rules' | 'llm';
  reason?: string;
}

function isCategory(value: unknown): value is UnitCategory {
  return typeof value === 'string' && (UNIT_CATEGORIES as readonly string[]).includes(value);
}

/** LLM-assisted classification with a deterministic rules fallback. */
export async function classifyUnit(
  llm: LlmClient | undefined,
  unit: ClassifiableUnit,
  mode: 'rules' | 'llm' | 'auto' = 'auto',
): Promise<ClassifyOutcome> {
  const rules = classifyUnitRuleBased(unit);
  if (mode === 'rules' || !llm) return { category: rules, via: 'rules' };
  try {
    const prompt = [
      LLM_CLASSIFY_INTENT,
      `Taxonomy: ${UNIT_CATEGORIES.join(', ')}.`,
      `Title: ${unit.title}`,
      `Type: ${unit.type}`,
      `Tags: ${unit.tags.join(', ') || '(none)'}`,
      `Return JSON: {"category":"<one of taxonomy>","reason":"<short reason>"}`,
    ].join('\n');
    const out = await llm.completeJSON<{ category?: string; reason?: string }>(prompt, { maxTokens: 300 });
    if (out && isCategory(out.category)) {
      return { category: out.category, via: 'llm', reason: out.reason };
    }
  } catch {
    // Provider failure must never block classification: fall back to rules.
  }
  return { category: rules, via: 'rules' };
}

export interface ClassifyReport {
  examined: number;
  classified: number;
  skipped: number;
  byCategory: Partial<Record<UnitCategory, number>>;
  viaRules: number;
  viaLlm: number;
  /** Number of label changes persisted to storage (service layer). */
  persisted?: number;
}

/** Batch classification. When ids is omitted, scans every unclassified unit. */
export async function classifyUnits(
  llm: LlmClient | undefined,
  units: Unit[],
  opts: { ids?: string[]; mode?: 'rules' | 'llm' | 'auto'; reclassify?: boolean } = {},
): Promise<ClassifyReport> {
  const mode = opts.mode ?? 'auto';
  const idSet = opts.ids ? new Set(opts.ids) : null;
  const targets = units.filter(
    (u) =>
      (!idSet || idSet.has(u.id)) &&
      u.status !== 'archived' &&
      (opts.reclassify || typeof u.labels?.category !== 'string' || !u.labels.category),
  );
  const report: ClassifyReport = {
    examined: targets.length,
    classified: 0,
    skipped: 0,
    byCategory: {},
    viaRules: 0,
    viaLlm: 0,
  };
  for (const u of targets) {
    const outcome = await classifyUnit(llm, u, mode);
    u.labels = { ...(u.labels ?? {}), category: outcome.category };
    report.classified += 1;
    report.byCategory[outcome.category] = (report.byCategory[outcome.category] ?? 0) + 1;
    if (outcome.via === 'llm') report.viaLlm += 1;
    else report.viaRules += 1;
  }
  return report;
}
