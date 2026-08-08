/**
 * Wiki asset extraction (自动沉淀资产).
 *
 * Aggregates units distilled from document files (importDirectory / ingest
 * with a file source) into per-page Wiki assets. Zero LLM calls: pages are
 * grouped by source uri and upserted idempotently by name, so re-running
 * merges new units into the same page instead of duplicating.
 */
import type { Asset, AssetExtractResult, Unit } from './domain.js';
import type { Storage } from './store.js';
import { newId, nowIso } from './lib/util.js';

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

interface WikiUnitRef {
  id: string;
  title: string;
  summary: string;
  type: string;
}

interface WikiPayload {
  generatedAt: string;
  page: string;
  sourceUri: string;
  units: WikiUnitRef[];
}

function looksLikeDoc(uri: string): boolean {
  const ext = uri.slice(uri.lastIndexOf('.')).toLowerCase();
  return DOC_EXTENSIONS.has(ext);
}

function wikiBody(page: string, units: Unit[]): string {
  const sections = units
    .map((u) => `## ${u.title}\n\n${u.summary}\n\n${u.body}`)
    .join('\n\n');
  return `# ${page}\n\n${sections}`;
}

/**
 * Build Wiki page assets from units cited by document sources, one page per
 * source uri. Idempotent by name (page path).
 */
export async function extractWiki(
  storage: Storage,
  opts: { limit?: number } = {},
): Promise<AssetExtractResult> {
  const all = await storage.allUnitsWithEmbeddings();
  const active = all.filter(
    (u) => u.status !== 'archived' && u.status !== 'merged',
  );

  const idsByUnit = new Map<string, string[]>();
  const sourceIds = new Set<string>();
  for (const u of active) {
    const ids = await storage.distinctSourceIdsForUnit(u.id);
    if (ids.length === 0) continue;
    idsByUnit.set(u.id, ids);
    for (const id of ids) sourceIds.add(id);
  }

  const sources = await storage.sourcesByIds([...sourceIds]);
  const uriById = new Map<string, string>();
  for (const s of sources) {
    if (s.uri && looksLikeDoc(s.uri)) uriById.set(s.id, s.uri);
  }

  const unitsByPage = new Map<string, Unit[]>();
  for (const u of active) {
    const ids = idsByUnit.get(u.id);
    if (!ids) continue;
    const pages = new Set(
      ids.map((id) => uriById.get(id)).filter((x): x is string => Boolean(x)),
    );
    for (const page of pages) {
      unitsByPage.set(page, [...(unitsByPage.get(page) ?? []), u]);
    }
  }

  const existing = await storage.listAssets({ kind: 'wiki' });
  const byName = new Map(existing.map((a) => [a.name.toLowerCase(), a]));
  let created = 0;
  let updated = 0;
  const now = nowIso();

  for (const page of [...unitsByPage.keys()].sort().slice(0, opts.limit ?? 50)) {
    const units = [...(unitsByPage.get(page) ?? [])].sort((a, b) =>
      a.title < b.title ? -1 : 1,
    );
    const payload: WikiPayload = {
      generatedAt: now,
      page,
      sourceUri: page,
      units: units.map((u) => ({
        id: u.id,
        title: u.title,
        summary: u.summary,
        type: u.type,
      })),
    };
    const key = page.toLowerCase();
    const existingAsset = byName.get(key);
    const asset: Asset = {
      id: existingAsset?.id ?? newId('asset'),
      kind: 'wiki',
      name: page,
      description: `Wiki page from ${units.length} unit(s): ${units[0]?.summary ?? ''}`,
      content: JSON.stringify(payload),
      body: wikiBody(page, units),
      trigger: `when documenting, reading, or recalling ${page}`,
      tags: [...new Set(['wiki', ...units.flatMap((u) => u.tags)])].slice(0, 10),
      sourceUnitIds: units.map((u) => u.id),
      status: existingAsset?.status ?? 'draft',
      visibility: existingAsset?.visibility ?? 'workspace',
      boundAgents: existingAsset?.boundAgents ?? [],
      version: (existingAsset?.version ?? 0) + 1,
      createdAt: existingAsset?.createdAt ?? now,
      updatedAt: now,
    };
    if (existingAsset) {
      await storage.updateAsset(asset);
      updated++;
    } else {
      await storage.createAsset(asset);
      byName.set(key, asset);
      created++;
    }
  }

  const assets = (await storage.listAssets({ kind: 'wiki' })).sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );
  return { created, updated, assets };
}
