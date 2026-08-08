/**
 * L2/L3 distillation engines (TencentDB-Agent-Memory style layering).
 *
 * L2 Scenario: an LLM consolidates many L1 units around a project/scenario
 * into one compact narrative knowledge block (create / integrate / rewrite).
 * L3 Persona: a long-term, short profile distilled from scenarios + high
 * importance units. Both reduce the tokens needed to bootstrap an agent's
 * context while keeping provenance (sourceUnitIds) for drill-down.
 *
 * When no real LLM is configured, deterministic heuristics produce the same
 * shapes so the pipeline stays testable and offline-usable.
 */
import type {
  AmemConfig,
  LayerRefreshResult,
  Persona,
  Scenario,
  Unit,
} from './domain.js';
import type { Storage } from './store.js';
import type { LlmClient } from './llm.js';
import { countTokens } from './lib/tokenizer.js';
import { newId, nowIso } from './lib/util.js';
import { mergeContent } from './scenes.js';

export const LLM_SCENARIO_INTENT = 'consolidate units into a scenario narrative block';
export const LLM_PERSONA_INTENT = 'persona profile of the workspace owner';

export const DEFAULT_MAX_SCENARIOS = 12;
export const PERSONA_MAX_CHARS = 2000;

interface ScenarioCandidate {
  tag: string;
  units: Unit[];
}

interface ScenarioDraft {
  title: string;
  summary: string;
  content: string;
}

/**
 * How much LLM work a layer refresh should do.
 * - `fast`: deterministic heuristics only, zero LLM calls (instant, offline-safe).
 * - `auto` (default): LLM only for large scenario groups (>= 3 units); persona is heuristic.
 * - `full`: LLM for every group and the persona (slow with slow providers; falls back to heuristics on error).
 */
export type LayerRefreshMode = 'fast' | 'auto' | 'full';

export interface LayerRefreshOptions {
  tags?: string[];
  forcePersona?: boolean;
  maxScenarios?: number;
  mode?: LayerRefreshMode;
}

function scenarioDraftFromUnits(tag: string, units: Unit[]): ScenarioDraft {
  const sorted = [...units].sort((a, b) => b.importance - a.importance);
  const content = sorted
    .map((u) => `- **${u.title}**: ${u.summary || u.body.slice(0, 160)}`)
    .join('\n');
  const top = sorted
    .slice(0, 3)
    .map((u) => u.title)
    .join(' / ');
  return {
    title: tag,
    summary: `${sorted.length} unit(s): ${top}`,
    content: content || `# ${tag}\n\n(no content yet)`,
  };
}

function groupUnitsByTag(units: Unit[], tags?: string[], maxScenarios = DEFAULT_MAX_SCENARIOS): ScenarioCandidate[] {
  const counts = new Map<string, number>();
  for (const u of units) {
    for (const t of u.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (tags && tags.length > 0) {
    // explicit tag list: each tag becomes a scenario group
    return tags
      .map((tag) => ({ tag, units: units.filter((u) => u.tags.includes(tag)) }))
      .filter((g) => g.units.length > 0);
  }
  const ranked = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxScenarios)
    .map(([tag]) => tag);
  return ranked
    .map((tag) => ({ tag, units: units.filter((u) => u.tags.includes(tag)) }))
    .filter((g) => g.units.length > 0);
}

function buildScenarioPrompt(existing: Scenario | null, draft: ScenarioCandidate): string {
  const unitLines = draft.units
    .slice(0, 25)
    .map(
      (u, i) =>
        `${i + 1}. [${u.type}] ${u.title}\n   ${u.summary || ''}\n   ${u.body.slice(0, 300)}`,
    )
    .join('\n');
  const existingBlock = existing
    ? `Existing scenario:\nTitle: ${existing.title}\nSummary: ${existing.summary}\nContent:\n${existing.content.slice(0, 1500)}`
    : 'No existing scenario.';
  return [
    LLM_SCENARIO_INTENT,
    ' for the project/topic tagged "' + draft.tag + '".',
    'Return ONLY valid JSON: {"title":"short scenario title","summary":"one line","content":"compact markdown narrative that merges the new units into the existing story (create or integrate/rewrite). Preserve durable facts, decisions, procedures, constraints. Keep under 900 tokens."}.',
    existingBlock,
    '---NEW UNITS---',
    unitLines,
  ].join('\n');
}

function buildPersonaPrompt(scenarios: Scenario[], units: Unit[]): string {
  const scenarioLines = scenarios
    .slice(0, 8)
    .map((s) => `- ${s.title}: ${s.summary}`)
    .join('\n');
  const unitLines = units
    .slice(0, 25)
    .map((u) => `- [${u.type}] ${u.title}: ${u.summary || u.body.slice(0, 160)}`)
    .join('\n');
  return [
    LLM_PERSONA_INTENT,
    '. Distill ONLY from the knowledge below. Return ONLY valid JSON: {"content":"short stable profile (identity, preferences, working style, recurring goals) under 2000 characters, no speculation"}',
    '---SCENARIOS---',
    scenarioLines || '(none)',
    '---KEY UNITS---',
    unitLines || '(none)',
  ].join('\n');
}

function personaFromUnits(scenarios: Scenario[], units: Unit[]): string {
  const parts: string[] = [];
  if (scenarios.length > 0) {
    parts.push('Working areas:');
    for (const s of scenarios.slice(0, 8)) parts.push(`- ${s.title}: ${s.summary}`);
  }
  const prefs = units
    .filter((u) => u.type === 'preference' || u.type === 'lesson')
    .slice(0, 12);
  if (prefs.length > 0) {
    parts.push('Preferences and lessons:');
    for (const u of prefs) parts.push(`- ${u.title}: ${u.summary}`);
  }
  const content = parts.join('\n').slice(0, PERSONA_MAX_CHARS);
  return content || '(no stable profile yet)';
}

function isScenarioDraft(v: unknown): v is ScenarioDraft {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.title === 'string' && typeof o.summary === 'string' && typeof o.content === 'string';
}

/**
 * Consolidate L1 units into L2 scenario blocks and (optionally) refresh the
 * L3 persona. Never throws on LLM failure: falls back to heuristics.
 */
export async function refreshLayers(
  llm: LlmClient,
  storage: Storage,
  config: AmemConfig,
  opts: LayerRefreshOptions = {},
): Promise<LayerRefreshResult> {
  const mode = opts.mode ?? 'auto';
  const maxScenarios = opts.maxScenarios ?? DEFAULT_MAX_SCENARIOS;
  const all = await storage.allUnitsWithEmbeddings();
  const active = all.filter((u) => u.status !== 'archived' && u.status !== 'merged');
  const groups = groupUnitsByTag(active, opts.tags, maxScenarios);

  let scenariosCreated = 0;
  let scenariosUpdated = 0;
  let unitsCovered = 0;
  const now = nowIso();

  for (const group of groups) {
    const existingList = await storage.listScenarios({ tag: group.tag, status: 'active' });
    const existing = existingList.find((s) => s.tags.includes(group.tag)) ?? null;
    let draft: ScenarioDraft;
    const useLlm = mode === 'full' || (mode === 'auto' && group.units.length >= 3);
    if (!useLlm) {
      draft = scenarioDraftFromUnits(group.tag, group.units);
    } else {
      try {
        const parsed = await llm.completeJSON<ScenarioDraft>(buildScenarioPrompt(existing, group));
        draft = isScenarioDraft(parsed) ? parsed : scenarioDraftFromUnits(group.tag, group.units);
      } catch {
        draft = scenarioDraftFromUnits(group.tag, group.units);
      }
    }
    const sourceUnitIds = group.units.map((u) => u.id);
    const tags = [...new Set([group.tag, ...group.units.flatMap((u) => u.tags)])].slice(0, 8);
    if (existing) {
      const next: Scenario = {
        ...existing,
        // Fast/heuristic refresh must preserve scene continuity (title + accumulated
        // conversation content); only an LLM pass is allowed to rewrite the block.
        title: useLlm ? draft.title || existing.title : existing.title || draft.title,
        summary: draft.summary || existing.summary,
        content: useLlm ? draft.content || existing.content : mergeContent(existing.content, draft.content),
        tags,
        sourceUnitIds,
        status: 'active',
        version: existing.version + 1,
        updatedAt: now,
        lastConsolidatedAt: now,
      };
      await storage.updateScenario(next);
      scenariosUpdated++;
    } else {
      await storage.createScenario({
        id: newId('scene'),
        title: draft.title || group.tag,
        summary: draft.summary,
        content: draft.content,
        tags,
        sourceUnitIds,
        status: 'active',
        version: 1,
        heat: 0,
        createdAt: now,
        updatedAt: now,
        lastConsolidatedAt: now,
      });
      scenariosCreated++;
    }
    unitsCovered += sourceUnitIds.length;
  }

  let personaUpdated = false;
  const allScenarios = await storage.listScenarios({ status: 'active', limit: maxScenarios });
  const important = [...active]
    .sort((a, b) => b.importance - a.importance || (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 30);
  let content = '';
  if (mode === 'full') {
    try {
      const parsed = await llm.completeJSON<{ content?: string }>(buildPersonaPrompt(allScenarios, important));
      content = typeof parsed?.content === 'string' && parsed.content.trim() ? parsed.content : '';
    } catch {
      content = '';
    }
  }
  if (!content) content = personaFromUnits(allScenarios, important);
  content = content.slice(0, PERSONA_MAX_CHARS).trim() || '(no stable profile yet)';

  const existingPersona = await storage.getPersona();
  if (!existingPersona || existingPersona.content !== content || opts.forcePersona) {
    await storage.upsertPersona({
      id: existingPersona?.id ?? newId('pers'),
      content,
      version: (existingPersona?.version ?? 0) + 1,
      createdAt: existingPersona?.createdAt ?? now,
      updatedAt: now,
    });
    personaUpdated = true;
  }

  void config; // config kept in signature for future per-workspace budgets
  return {
    scenariosCreated,
    scenariosUpdated,
    personaUpdated,
    skillsExtracted: 0,
    skillsCreated: 0,
    skillsUpdated: 0,
    unitsCovered,
  };
}

/** Rough token estimate for a persona (used by callers for budget math). */
export function personaTokenCount(persona: Persona): number {
  return countTokens(persona.content);
}
