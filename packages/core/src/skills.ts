/**
 * Skill asset extraction (自动沉淀资产).
 *
 * Converts L1 procedure/lesson/preference units into portable Skill assets
 * (name, description, trigger, steps, validation). Skills are decoupled from
 * any agent framework: they can be reviewed, published, shared, and re-armed
 * by any agent (Codex, Claude Code, ...).
 */
import type { Asset, SkillExtractResult, Unit } from './domain.js';
import type { Storage } from './store.js';
import type { LlmClient } from './llm.js';
import { newId, nowIso } from './lib/util.js';

export const LLM_SKILL_INTENT = 'extract reusable skills from knowledge units';

const SKILL_UNIT_TYPES = new Set(['procedure', 'lesson', 'preference', 'decision']);

interface SkillDraft {
  name: string;
  description: string;
  trigger: string;
  steps: string[];
  validation?: string;
  tags?: string[];
}

interface SkillsPayload {
  skills: SkillDraft[];
}

const SKILLS_BATCH = 5;

function skillDraftFromUnit(u: Unit): SkillDraft {
  const lines = u.body
    .split(/\n+/)
    .map((l) => l.replace(/^[-*\d.\s)]+/, '').trim())
    .filter((l) => l.length > 2);
  return {
    name: u.title.replace(/\s+/g, ' ').slice(0, 80),
    description: u.summary || lines[0] || u.title,
    trigger: u.tags.join(', '),
    steps: lines.length > 0 ? lines : [u.body.slice(0, 200)],
    validation: u.type === 'lesson' ? 'Verify against a fresh run before reuse.' : undefined,
    tags: u.tags,
  };
}

function buildSkillPrompt(units: Unit[]): string {
  const unitLines = units
    .map(
      (u, i) =>
        `${i + 1}. [${u.type}] ${u.title}\n   ${u.summary}\n   ${u.body.slice(0, 700)}`,
    )
    .join('\n');
  return [
    LLM_SKILL_INTENT,
    '. Return ONLY valid JSON: {"skills":[{"name":"short verb phrase","description":"one line","trigger":"when to use (e.g. before release, when debugging X)","steps":["step 1", ...],"validation":"how to verify","tags":["a","b"]}]}.',
    'Keep steps concrete and executable by an agent. No markdown fences.',
    '---UNITS---',
    unitLines,
  ].join('\n');
}

function isSkillsPayload(v: unknown): v is SkillsPayload {
  if (!v || typeof v !== 'object') return false;
  const arr = (v as Record<string, unknown>).skills;
  return (
    Array.isArray(arr) &&
    arr.every(
      (s) =>
        s !== null &&
        typeof s === 'object' &&
        typeof (s as Record<string, unknown>).name === 'string' &&
        typeof (s as Record<string, unknown>).description === 'string' &&
        Array.isArray((s as Record<string, unknown>).steps),
    )
  );
}

function skillBody(s: SkillDraft): string {
  const steps = (s.steps ?? [])
    .map((step, i) => `${i + 1}. ${step}`)
    .join('\n');
  const validation = s.validation ? `\n\n## Validation\n${s.validation}` : '';
  return `# ${s.name}\n\n${s.description}\n\n## Steps\n${steps}${validation}`;
}

/** Content-bearing fields only: pure routing/metadata changes do not fork the version chain. */
export function assetContentChanged(a: Asset, b: Asset): boolean {
  return (
    a.name !== b.name ||
    a.description !== b.description ||
    a.content !== b.content ||
    a.body !== b.body ||
    a.trigger !== b.trigger ||
    JSON.stringify(a.tags) !== JSON.stringify(b.tags)
  );
}

/**
 * Extract Skill assets from procedure/lesson units. Idempotent: skills are
 * upserted by name, so re-running merges new steps instead of duplicating.
 */
export async function extractSkills(
  llm: LlmClient,
  storage: Storage,
  opts: { limit?: number; includePending?: boolean; heuristic?: boolean } = {},
): Promise<SkillExtractResult> {
  const all = await storage.allUnitsWithEmbeddings();
  const candidates = all
    .filter((u) => SKILL_UNIT_TYPES.has(u.type) && u.status !== 'archived' && u.status !== 'merged')
    .filter((u) => opts.includePending || u.status !== 'pending')
    .sort((a, b) => {
      const ar = a.status === 'reviewed' ? 1 : 0;
      const br = b.status === 'reviewed' ? 1 : 0;
      return br - ar || b.importance - a.importance || (a.updatedAt < b.updatedAt ? 1 : -1);
    })
    .slice(0, opts.limit ?? 20);

  const existing = await storage.listAssets({ kind: 'skill' });
  const byName = new Map(existing.map((a) => [a.name.toLowerCase(), a]));
  const covered = new Set(existing.flatMap((a) => a.sourceUnitIds));
  const fresh = candidates.filter((u) => !covered.has(u.id));
  const inputs = fresh.length > 0 ? fresh : candidates.slice(0, SKILLS_BATCH);

  let created = 0;
  let updated = 0;
  const now = nowIso();

  const upsert = async (draft: SkillDraft, sourceUnitIds: string[]): Promise<void> => {
    const key = draft.name.trim().toLowerCase();
    if (!key) return;
    const existingAsset = byName.get(key);
    const draftAsset: Asset = {
      id: existingAsset?.id ?? newId('asset'),
      kind: 'skill',
      name: draft.name.trim(),
      description: draft.description.trim(),
      content: JSON.stringify({
        name: draft.name.trim(),
        description: draft.description.trim(),
        trigger: draft.trigger,
        steps: draft.steps ?? [],
        validation: draft.validation,
        tags: draft.tags ?? [],
      }),
      body: skillBody(draft),
      trigger: draft.trigger ?? '',
      tags: [...new Set([...(draft.tags ?? []), ...(existingAsset?.tags ?? [])])].slice(0, 10),
      sourceUnitIds: [...new Set([...(existingAsset?.sourceUnitIds ?? []), ...sourceUnitIds])],
      status: existingAsset?.status ?? 'draft',
      visibility: existingAsset?.visibility ?? 'workspace',
      boundAgents: existingAsset?.boundAgents ?? [],
      version: (existingAsset?.version ?? 0) + 1,
      createdAt: existingAsset?.createdAt ?? now,
      updatedAt: now,
    };
    if (existingAsset) {
      const contentChanged = assetContentChanged(existingAsset, draftAsset);
      const provenanceChanged =
        JSON.stringify(existingAsset.sourceUnitIds) !== JSON.stringify(draftAsset.sourceUnitIds);
      // True no-op (Tencent appendVersion IdempotentNoOp semantics): nothing changed.
      if (!contentChanged && !provenanceChanged) return;
      if (contentChanged) {
        await storage.snapshotAssetVersion(existingAsset, 'skill-extract: content changed');
      } else {
        // Provenance-only growth: keep the version number stable, no snapshot.
        draftAsset.version = existingAsset.version;
      }
      await storage.updateAsset(draftAsset);
      updated++;
    } else {
      await storage.createAsset(draftAsset);
      byName.set(key, draftAsset);
      created++;
    }
  };

  // Batch LLM extraction over fresh candidates; fall back per-unit heuristics.
  for (let i = 0; i < inputs.length; i += SKILLS_BATCH) {
    const batch = inputs.slice(i, i + SKILLS_BATCH);
    let drafts: SkillDraft[] = [];
    if (opts.heuristic) {
      drafts = batch.map(skillDraftFromUnit);
    } else {
      try {
        const parsed = await llm.completeJSON<SkillsPayload>(buildSkillPrompt(batch));
        if (isSkillsPayload(parsed)) drafts = parsed.skills;
      } catch {
        drafts = [];
      }
    }
    if (drafts.length === 0) {
      drafts = batch.map(skillDraftFromUnit);
    }
    for (const draft of drafts) {
      const src = batch.filter((u) => u.title.toLowerCase().includes(draft.name.toLowerCase()));
      const sourceUnitIds = src.length > 0 ? src.map((u) => u.id) : batch.map((u) => u.id);
      await upsert(draft, sourceUnitIds);
    }
  }

  const assets = (await storage.listAssets({ kind: 'skill' })).sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );
  return { created, updated, assets };
}
