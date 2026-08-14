import type { IsoDate, Unit, UnitSummary } from '../domain.js';

/** Short, unique id with a human-friendly prefix. */
export function newId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? '';
  const rnd = uuid ? uuid.slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}`;
}

export function nowIso(): IsoDate {
  return new Date().toISOString();
}

export function ageInDays(iso: IsoDate, nowMs = Date.now()): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (nowMs - then) / 86_400_000);
}

/** 0..1 recency, exponentially decaying over ~30 days. */
export function recencyScore(iso: IsoDate, nowMs = Date.now()): number {
  return Math.exp(-ageInDays(iso, nowMs) / 30);
}

export function toUnitSummary(unit: Unit): UnitSummary {
  const category = unit.labels?.category;
  return {
    id: unit.id,
    type: unit.type,
    form: unit.form,
    title: unit.title,
    summary: unit.summary,
    tags: unit.tags,
    category: typeof category === 'string' && category ? category : undefined,
    zoneId: unit.zoneId,
    workspaceId: unit.workspaceId,
    createdByUserId: unit.createdByUserId,
    agent: unit.agent,
    importance: unit.importance,
    decay: unit.decay,
    status: unit.status,
    updatedAt: unit.updatedAt,
  };
}

export function snapshotOf(unit: Unit): Omit<Unit, 'embedding'> {
  const snapshot = { ...unit } as Partial<Unit>;
  delete snapshot.embedding;
  return snapshot as Omit<Unit, 'embedding'>;
}
