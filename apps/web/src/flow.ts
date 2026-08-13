import type { ActivitySummary } from './types';

export interface FlowCard {
  id: 'in' | 'out' | 'saved' | 'events';
  label: string;
  value: number;
  detail: string;
}

function topKind(byKind: Record<string, number>): string {
  return Object.entries(byKind).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** Four headline cards for the data-flow panel (writes in / reads out / token economics / window size). */
export function flowCards(s: ActivitySummary): FlowCard[] {
  const inKind = topKind(s.input.byKind);
  const outKind = topKind(s.output.byKind);
  return [
    {
      id: 'in',
      label: 'Knowledge in',
      value: s.input.total,
      detail: `${s.input.unitsCreated} units distilled${inKind ? ` · ${inKind}` : ''}`,
    },
    {
      id: 'out',
      label: 'Knowledge out',
      value: s.output.total,
      detail: `${s.output.tokensDelivered.toLocaleString()} tokens delivered${outKind ? ` · ${outKind}` : ''}`,
    },
    {
      id: 'saved',
      label: 'Tokens saved',
      value: s.output.tokenSavings,
      detail: `budget ${s.output.budgetUsed.toLocaleString()}`,
    },
    {
      id: 'events',
      label: 'Events',
      value: s.window.events,
      detail: `last ${s.window.hours}h window`,
    },
  ];
}

export interface RegionRow {
  key: string;
  count: number;
  pct: number;
}

/** Sort region rows by count desc and attach the share of `total` accessed units. */
export function regionRows(rows: Array<{ key: string; count: number }>, total: number): RegionRow[] {
  const denom = Math.max(1, total);
  return [...rows]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map((r) => ({ key: r.key, count: r.count, pct: Math.round((r.count / denom) * 100) }));
}

export interface AccessRow {
  unitId: string;
  title: string;
  type: string;
  category: string;
  tags: string[];
  accessCount: number;
  lastAccessedAt: string;
  actors: string[];
}

/** Top accessed units as renderable rows, tags capped for compact chips. */
export function accessRows(s: ActivitySummary | null, limit = 8): AccessRow[] {
  if (!s) return [];
  return s.accessedUnits.slice(0, limit).map((u) => ({ ...u, tags: u.tags.slice(0, 4) }));
}

export function actorTotal(a: { actor: string; writes: number; reads: number }): number {
  return a.writes + a.reads;
}
