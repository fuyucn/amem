import type { AmemConfig, IsoDate, Unit, UnitSummary, WorkingMemory } from './domain.js';
import type { Storage } from './store.js';
import { countTokens } from './lib/tokenizer.js';
import { recencyScore, toUnitSummary } from './lib/util.js';

/** Compact daily briefing of the most relevant active units within a token budget. */
export async function buildWorkingMemory(
  storage: Storage,
  config: AmemConfig,
  date: IsoDate,
  budget?: number,
): Promise<WorkingMemory> {
  const cap = budget ?? config.thresholds.workingMemoryBudget;
  const all = await storage.allUnitsWithEmbeddings();
  const active = all.filter((u) => u.status !== 'archived');

  const scored: Array<{ unit: Unit; score: number }> = active.map((unit) => ({
    unit,
    score: unit.importance * 0.4 + unit.decay * 0.3 + recencyScore(unit.updatedAt) * 0.3,
  }));
  scored.sort((a, b) => b.score - a.score);

  const blocks: string[] = [];
  const selected: UnitSummary[] = [];
  let tokenCount = 0;
  for (const { unit } of scored) {
    const block = `- [${unit.title}](#${unit.id}) — ${unit.summary}`;
    const tokens = countTokens(block);
    if (tokenCount + tokens > cap) break;
    tokenCount += tokens;
    blocks.push(block);
    selected.push(toUnitSummary(unit));
  }

  return { date, text: blocks.join('\n'), tokenCount, selected };
}
