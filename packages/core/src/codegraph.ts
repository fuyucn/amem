/**
 * CodeGraph asset extraction (自动沉淀资产).
 *
 * Aggregates L1 module/symbol units (imported by `importCodebase`) into a
 * portable CodeGraph asset per top-level directory. Zero LLM calls:
 * grouping is purely heuristic and assets are upserted idempotently by name,
 * so re-running merges new modules instead of duplicating.
 */
import type { Asset, AssetExtractResult, Unit } from './domain.js';
import type { Storage } from './store.js';
import { newId, nowIso } from './lib/util.js';

interface SymbolEntry {
  name: string;
  kind: string;
  signature: string;
  line: number;
}

interface ModuleEntry {
  path: string;
  lang: string;
  summary: string;
  symbols: SymbolEntry[];
}

interface CodegraphPayload {
  generatedAt: string;
  scope: string;
  modules: ModuleEntry[];
}

function topDir(rel: string): string {
  const parts = rel.split('/').filter(Boolean);
  return parts[0] ?? '(root)';
}

function modulePath(m: Unit): string {
  return m.title.replace(/^Module:\s*/, '').trim();
}

function symbolFromUnit(u: Unit): SymbolEntry | null {
  const name = u.title.split(' — ')[0]?.replace(/^[^:]+:\s*/, '').trim() ?? '';
  const symbolKind = u.labels.symbolKind;
  const kind =
    typeof symbolKind === 'string'
      ? symbolKind
      : (u.title.split(':')[0] ?? '').trim();
  const line = Number(u.body.match(/Line:\s*(\d+)/)?.[1]) || 0;
  const signature = u.summary || (u.body.split('\n').find((l) => l.trim()) ?? '');
  if (!name) return null;
  return { name, kind, signature, line };
}

function codegraphBody(payload: CodegraphPayload): string {
  const sections = payload.modules.map((m) => {
    const syms =
      m.symbols.length > 0
        ? m.symbols
            .map((s) => `- ${s.kind} ${s.name}${s.line ? ` (line ${s.line})` : ''}`)
            .join('\n')
        : '(no symbols indexed)';
    return `## ${m.path}\n\n${m.summary}\n\n${syms}`;
  });
  return `# CodeGraph: ${payload.scope}\n\nIndexed ${payload.modules.length} module(s).\n\n${sections.join('\n\n')}`;
}

/**
 * Build CodeGraph assets from imported module/symbol units, grouped by the
 * top-level directory of each module's relative path. Idempotent by name.
 */
export async function extractCodegraph(
  storage: Storage,
  opts: { limit?: number } = {},
): Promise<AssetExtractResult> {
  const all = await storage.allUnitsWithEmbeddings();
  const active = (u: Unit) => u.status !== 'archived' && u.status !== 'merged';
  const modules = all.filter((u) => active(u) && u.labels.kind === 'module');
  const symbols = new Map(
    all.filter((u) => active(u) && u.labels.kind === 'symbol').map((u) => [u.id, u]),
  );

  const links = await storage.allLinks();
  const symbolIdsByModule = new Map<string, string[]>();
  for (const link of links) {
    if (link.relation === 'part_of' && symbols.has(link.targetUnitId)) {
      const arr = symbolIdsByModule.get(link.sourceUnitId) ?? [];
      arr.push(link.targetUnitId);
      symbolIdsByModule.set(link.sourceUnitId, arr);
    }
  }

  const byScope = new Map<string, Unit[]>();
  for (const m of modules) {
    const scope = topDir(modulePath(m));
    byScope.set(scope, [...(byScope.get(scope) ?? []), m]);
  }

  const existing = await storage.listAssets({ kind: 'codegraph' });
  const byName = new Map(existing.map((a) => [a.name.toLowerCase(), a]));
  let created = 0;
  let updated = 0;
  const now = nowIso();

  for (const scope of [...byScope.keys()].sort().slice(0, opts.limit ?? 20)) {
    const scopeModules = [...(byScope.get(scope) ?? [])].sort((a, b) =>
      a.title < b.title ? -1 : 1,
    );
    const moduleEntries: ModuleEntry[] = scopeModules.map((m) => {
      const kids = (symbolIdsByModule.get(m.id) ?? [])
        .map((id) => symbols.get(id))
        .filter((u): u is Unit => Boolean(u))
        .sort((a, b) => (a.title < b.title ? -1 : 1));
      return {
        path: modulePath(m),
        lang: String(m.labels.lang ?? 'unknown'),
        summary: m.summary,
        symbols: kids
          .map(symbolFromUnit)
          .filter((s): s is SymbolEntry => Boolean(s)),
      };
    });
    const symbolCount = moduleEntries.reduce((n, m) => n + m.symbols.length, 0);
    const payload: CodegraphPayload = {
      generatedAt: now,
      scope,
      modules: moduleEntries,
    };
    const key = `codegraph: ${scope}`.toLowerCase();
    const existingAsset = byName.get(key);
    const asset: Asset = {
      id: existingAsset?.id ?? newId('asset'),
      kind: 'codegraph',
      name: `codegraph: ${scope}`,
      description: `Code index for ${scope}: ${moduleEntries.length} module(s), ${symbolCount} symbol(s)`,
      content: JSON.stringify(payload),
      body: codegraphBody(payload),
      trigger: `when writing or reading code under ${scope}/`,
      tags: [
        ...new Set(['codegraph', scope, ...moduleEntries.map((m) => m.lang)]),
      ].slice(0, 10),
      sourceUnitIds: scopeModules.map((m) => m.id),
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

  const assets = (await storage.listAssets({ kind: 'codegraph' })).sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );
  return { created, updated, assets };
}
