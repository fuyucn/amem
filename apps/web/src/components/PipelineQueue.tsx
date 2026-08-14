import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PipelineStage } from '../types';

/**
 * Real memory pipeline. Each card is one memory card (a trace or a unit) and
 * every stage is a row the backend actually wrote to `pipeline_stages` with
 * its real timestamp — ingest → stored/distilled → curated → delivered.
 *
 * The queue starts EMPTY on mount: it only shows stages that arrive while the
 * page is open (polled via /api/v1/pipeline), so the conveyor is a live view
 * of work flowing through the store, never a replay of history.
 */

const STAGES = [
  { name: 'Incoming', hint: 'raw traces' },
  { name: 'Stored', hint: 'saved units' },
  { name: 'Distilled', hint: 'units from ingest' },
  { name: 'Curate', hint: 'linked · classified' },
  { name: 'Delivered', hint: 'recalled by agents' },
] as const;

const KIND_STAGE: Record<string, number> = {
  ingested: 0,
  stored: 1,
  distilled: 2,
  curated: 3,
  recalled: 4,
};

/** How long a card with no newer stage stays on the conveyor. */
const HOLD_MS: Record<number, number> = {
  0: 24_000, // raw trace: hangs around long enough to see its distilled children
  1: 30_000,
  2: 30_000,
  3: 20_000,
  4: 14_000, // recalled: pulses on Delivered, then fades out
};

interface QueueCard {
  key: string;
  title: string;
  kind: string;
  actor?: string;
  at: string;
  stage: number;
  born: number;
  lastMove: number;
}

function stageOf(kind: string): number {
  return KIND_STAGE[kind] ?? 0;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function PipelineQueue() {
  const [cards, setCards] = useState<QueueCard[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const seen = useRef(new Set<string>());
  const since = useRef(Date.now());
  const mounted = useRef(true);
  const pausedRef = useRef(false);

  // Poll the real pipeline: only stages newer than page-open time.
  const poll = useCallback(async () => {
    if (pausedRef.current || !mounted.current) return;
    try {
      const stages = await api.pipeline({ limit: 80 });
      const fresh = stages
        .filter(
          (s) =>
            !seen.current.has(s.id) &&
            new Date(s.createdAt).getTime() >= since.current,
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      if (fresh.length === 0) return;
      setCards((prev) => {
        const byKey = new Map(prev.map((c) => [c.key, c]));
        for (const s of fresh) {
          seen.current.add(s.id);
          applyStage(byKey, s);
        }
        return [...byKey.values()];
      });
      setError('');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    pausedRef.current = false;
    since.current = Date.now();
    void poll();
    const id = window.setInterval(() => {
      if (!mounted.current || pausedRef.current) return;
      void poll();
    }, 2500);
    return () => {
      mounted.current = false;
      window.clearInterval(id);
    };
  }, [poll]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Expire cards whose last stage happened too long ago.
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setCards((prev) =>
        prev.filter((c) => now - c.lastMove < (HOLD_MS[c.stage] ?? 20_000)),
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, [paused]);

  const counts = STAGES.map((_, i) => cards.filter((c) => c.stage === i).length);
  const busy = counts.some((n) => n > 0);

  return (
    <div className="queue-wrap">
      <div className="queue">
        {STAGES.map((s, i) => {
          const colCards = cards.filter((c) => c.stage === i);
          return (
            <Fragment key={s.name}>
              {i > 0 && <span className="queue-arrow" aria-hidden="true">→</span>}
              <div className="queue-col">
                <div className="queue-col-head">
                  <i className={`q-led ${colCards.length > 0 ? 'busy' : ''}`} />
                  <span className="queue-col-name">{s.name}</span>
                  <span className="queue-col-count">{colCards.length}</span>
                </div>
                <div className="queue-col-hint">{s.hint}</div>
                <div className="q-col-body">
                  {colCards.length === 0 && <div className="q-idle">idle</div>}
                  {colCards.map((c, idx) => (
                    <div
                      key={c.key}
                      className={`q-card ${c.stage === 4 ? 'use' : ''}`}
                      style={{ animationDelay: `${Math.min(idx, 4) * 60}ms` }}
                      title={`${c.kind} · ${c.title}`}
                    >
                      <div className="q-card-title">{c.title}</div>
                      <div className="q-card-meta">
                        <span className="q-kind">{c.kind}</span>
                        {c.actor && <span className="q-actor">{c.actor}</span>}
                        <span className="q-time">{relTime(c.at)}</span>
                      </div>
                      <div className="q-progress">
                        <i style={{ width: `${((c.stage + 1) / STAGES.length) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className="queue-foot">
        <span className={`q-led ${busy && !paused ? 'busy' : ''}`} />
        {paused ? 'queue paused' : busy ? 'live — cards move on real backend stages' : 'live — waiting for memory writes…'}
        {error && <span className="muted" style={{ marginLeft: 8 }}>poll error: {error}</span>}
        <button className="btn" style={{ marginLeft: 'auto', padding: '3px 10px' }} onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  );
}

/** Upsert a card for a fresh backend stage: new cards appear, existing cards
 *  advance right only (never backwards). */
function applyStage(byKey: Map<string, QueueCard>, s: PipelineStage): void {
  const stage = stageOf(s.kind);
  const existing = byKey.get(s.cardId);
  const now = Date.now();
  if (!existing) {
    byKey.set(s.cardId, {
      key: s.cardId,
      title: s.cardTitle,
      kind: s.kind,
      actor: s.actor,
      at: s.createdAt,
      stage,
      born: now,
      lastMove: now,
    });
    return;
  }
  if (stage > existing.stage) {
    byKey.set(s.cardId, {
      ...existing,
      title: s.cardTitle,
      kind: s.kind,
      actor: s.actor ?? existing.actor,
      at: s.createdAt,
      stage,
      lastMove: now,
    });
  } else if (existing.stage === stage) {
    // Same stage again (e.g. another save or recall) — refresh so the card
    // stays on the conveyor instead of expiring while still active.
    byKey.set(s.cardId, { ...existing, lastMove: now });
  }
}
