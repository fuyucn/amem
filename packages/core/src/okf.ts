import type { ExportBundle, Source, Unit, UnitSource } from './domain.js';

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  return slug;
}

const esc = (s: string): string => s.replace(/"/g, '\\"');

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'string') return `"${esc(value)}"`;
  return String(value);
}

function renderFrontmatter(unit: Unit): string {
  return [
    '---',
    `type: ${yamlScalar(unit.type)}`,
    `title: ${yamlScalar(unit.title)}`,
    `description: ${yamlScalar(unit.summary)}`,
    `tags: [${unit.tags.map((t) => yamlScalar(t)).join(', ')}]`,
    `timestamp: ${yamlScalar(unit.createdAt)}`,
    '---',
  ].join('\n');
}

function renderUnitPage(unit: Unit, unitSources: UnitSource[], sources: Source[]): string {
  const citedSources = unitSources
    .filter((c) => c.unitId === unit.id)
    .map((c) => sources.find((s) => s.id === c.sourceId))
    .filter((s): s is Source => Boolean(s));
  const lines: string[] = [renderFrontmatter(unit), '', unit.body, ''];
  if (citedSources.length > 0) {
    lines.push('## Citations', '');
    for (const s of citedSources) {
      lines.push(`- ${s.title}${s.uri ? ` — ${s.uri}` : ''} \`${s.id}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Render an ExportBundle into an Open Knowledge Format markdown bundle. */
export function renderOkfBundle(exp: ExportBundle): Map<string, string> {
  const bundle = new Map<string, string>();
  const usedSlugs = new Set<string>();
  const slugByUnit = new Map<string, string>();

  for (const unit of exp.units) {
    let slug = slugify(unit.title) || unit.id;
    let n = 2;
    while (usedSlugs.has(slug)) {
      slug = `${slugify(unit.title) || unit.id}-${n}`;
      n++;
    }
    usedSlugs.add(slug);
    slugByUnit.set(unit.id, slug);
    bundle.set(`pages/${slug}.md`, renderUnitPage(unit, exp.unitSources, exp.sources));
  }

  const toc = ['# Amem Knowledge Base', '', ...exp.units.map((u) => `- [${u.title}](pages/${slugByUnit.get(u.id) ?? u.id}.md)`)];
  bundle.set('index.md', toc.join('\n') + '\n');

  const log = [
    '# Change Log',
    '',
    `Exported: ${exp.exportedAt}`,
    '',
    ...exp.traces.map((t) => `- ${t.createdAt} — ${t.title}`),
    ...exp.units.map((u) => `- ${u.updatedAt} — updated "${u.title}"`),
  ];
  bundle.set('log.md', log.join('\n') + '\n');

  return bundle;
}
