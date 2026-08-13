import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ActivityEvent, ActivitySummary, UnitSummary } from '../types';
import { unitPath } from '../router';
import { accessRows, actorTotal, flowCards, regionRows } from '../flow';

const WRITE_KINDS = new Set(['ingest', 'save_unit', 'update_unit', 'review', 'link', 'import', 'curate', 'forget']);
const AUDIT_KINDS = new Set(['auth_login', 'auth_bootstrap', 'auth_token_create', 'auth_token_revoke', 'workspace_create', 'workspace_member_add', 'workspace_member_remove']);
const USE_KINDS = new Set(['recall', 'search', 'export', 'working_memory']);

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function titlesOf(ev: ActivityEvent): string[] {
  const meta = ev.meta ?? {};
  const t = meta.unitTitles;
  if (Array.isArray(t)) return t.map(String).slice(0, 8);
  if (typeof meta.unitTitle === 'string') return [meta.unitTitle];
  return [];
}

function EventCard({ ev }: { ev: ActivityEvent }) {
  const titles = titlesOf(ev);
  const query = typeof ev.meta?.query === 'string' ? ev.meta.query : undefined;
  return (
    <li className="event-card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className={`badge kind-${ev.kind}`}>{ev.kind}</span>
        <span className="muted" title={ev.createdAt}>{relTime(ev.createdAt)}</span>
      </div>
      <div className="event-summary">{ev.summary}</div>
      {query && <div className="muted">query: {query}</div>}
      {titles.length > 0 && (
        <div className="row" style={{ marginTop: 6 }}>
          {titles.map((t) => (
            <span key={t} className="tag">{t}</span>
          ))}
        </div>
      )}
      {ev.actor && <div className="muted" style={{ marginTop: 4 }}>via {ev.actor}</div>}
    </li>
  );
}

export function Activity({ onOpenUnit }: { onOpenUnit?: (id: string) => void }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [recentUnits, setRecentUnits] = useState<UnitSummary[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'writes' | 'uses'>('all');
  const [regionTab, setRegionTab] = useState<'type' | 'category' | 'tag'>('type');
  const [auto, setAuto] = useState(true);

  const load = useCallback(async () => {
    try {
      const [acts, units, sum] = await Promise.all([
        api.activity({ limit: 80 }),
        api.units({ limit: 12 }),
        api.activitySummary({ hours: 24 }).catch(() => null),
      ]);
      setEvents(acts);
      setRecentUnits(units);
      setSummary(sum);
      setError('');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(id);
  }, [auto, load]);

  const filtered = useMemo(() => {
    if (filter === 'writes') return events.filter((e) => WRITE_KINDS.has(e.kind));
    if (filter === 'uses') return events.filter((e) => USE_KINDS.has(e.kind));
    return events;
  }, [events, filter]);

 const writes = events.filter((e) => WRITE_KINDS.has(e.kind)).slice(0, 20);
 const audits = events.filter((e) => AUDIT_KINDS.has(e.kind)).slice(0, 20);
  const uses = events.filter((e) => USE_KINDS.has(e.kind)).slice(0, 20);
  const accessed = accessRows(summary);
  const maxActor = Math.max(1, ...(summary?.topActors.map(actorTotal) ?? [0]));
  const regionSource =
    regionTab === 'type' ? summary?.regions.byType ?? []
    : regionTab === 'category' ? summary?.regions.byCategory ?? []
    : summary?.regions.byTag ?? [];

  return (
    <div className="grid">
      <div className="panel row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: '0 0 4px' }}>Activity</h2>
          <div className="muted">Live feed of knowledge written by Codex/agents and knowledge used via recall/search.</div>
        </div>
        <div className="row">
          <label className="muted row">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            auto-refresh
          </label>
          <button className="btn" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      {error && <div className="panel">Failed to load activity: {error}</div>}

      {summary && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>Data flow</h3>
            <span className="muted">last {summary.window.hours}h</span>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>
            Knowledge written into Amem vs. delivered back to agents in the window.
          </p>
          <div className="cards" style={{ marginTop: 10 }}>
            {flowCards(summary).map((c) => (
              <div className="card" key={c.id}>
                <div className="num">{c.value.toLocaleString()}</div>
                <div className="lbl">{c.label}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{c.detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Agent memory access</h3>
          {summary && summary.accessedUnits.length > 0 && (
            <span className="muted">{summary.accessedUnits.length} units touched</span>
          )}
        </div>
        {!summary || (accessed.length === 0 && summary.topActors.length === 0) ? (
          <div className="muted" style={{ marginTop: 8 }}>
            No recalls/searches in the window yet — Codex should call `recall` / `working_memory` at session start.
          </div>
        ) : (
          <div className="access-grid">
            <div>
              <h4>Top units</h4>
              {accessed.length === 0 && <div className="muted">No units hit by recall/search yet.</div>}
              <ul className="dots" style={{ marginTop: 6 }}>
                {accessed.map((u) => (
                  <li key={u.unitId}>
                    <a
                      className="unit-link"
                      href={unitPath(u.unitId)}
                      onClick={(e) => {
                        if (onOpenUnit) {
                          e.preventDefault();
                          onOpenUnit(u.unitId);
                        }
                      }}
                    >
                      <span className="badge">{u.type}</span> <b>{u.title}</b>
                    </a>
                    <div className="muted" style={{ marginTop: 2 }}>
                      {u.category} · {u.accessCount}x by {u.actors.join(', ') || 'unknown'}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                {(['type', 'category', 'tag'] as const).map((t) => (
                  <button key={t} className={`btn ${regionTab === t ? 'primary' : ''}`} onClick={() => setRegionTab(t)}>
                    {t}
                  </button>
                ))}
              </div>
              {regionRows(regionSource, summary?.accessedUnits.length ?? 0).length === 0 && (
                <div className="muted">No regions recorded yet.</div>
              )}
              {regionRows(regionSource, summary?.accessedUnits.length ?? 0).map((r) => (
                <div className="dist-row" key={r.key}>
                  <span className="dist-label">{r.key}</span>
                  <div className="dist-bar"><i style={{ width: `${r.pct}%` }} /></div>
                  <span className="dist-num">{r.count}</span>
                  <span className="dist-pct">{r.pct}%</span>
                </div>
              ))}
            </div>
            <div>
              <h4>Top actors</h4>
              {summary.topActors.length === 0 && <div className="muted">No actors recorded yet.</div>}
              {summary.topActors.slice(0, 5).map((a) => (
                <div className="dist-row" key={a.actor}>
                  <span className="dist-label">{a.actor}</span>
                  <div className="dist-bar"><i style={{ width: `${(actorTotal(a) / maxActor) * 100}%` }} /></div>
                  <span className="dist-num">{a.writes}w · {a.reads}r</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="cards">
        <div className="card"><div className="num">{events.length}</div><div className="lbl">Events loaded</div></div>
        <div className="card"><div className="num">{writes.length}</div><div className="lbl">Recent writes</div></div>
      <div className="card"><div className="num">{uses.length}</div><div className="lbl">Recent uses</div></div>
      <div className="card"><div className="num">{audits.length}</div><div className="lbl">Audit events</div></div>
      <div className="card"><div className="num">{recentUnits.length}</div><div className="lbl">Newest units</div></div>
      </div>

     <div className="activity-columns">
       <div className="panel">
        <h3>Security audit</h3>
         {audits.length === 0 && <div className="muted">No audit events yet. Login, create tokens, or manage workspaces to see events here.</div>}
         <ul className="event-list">
           {audits.map((ev) => <EventCard key={ev.id} ev={ev} />)}
         </ul>
       </div>
       <div className="panel">
        <h3>Newly added knowledge</h3>
          {writes.length === 0 && <div className="muted">No writes yet. Ask Codex to `ingest` a transcript or `save_unit` a decision.</div>}
          <ul className="event-list">
            {writes.map((ev) => <EventCard key={ev.id} ev={ev} />)}
          </ul>
        </div>
        <div className="panel">
          <h3>Used in context</h3>
          {uses.length === 0 && <div className="muted">No recalls/searches yet. Codex should call `recall` / `working_memory` at session start.</div>}
          <ul className="event-list">
            {uses.map((ev) => <EventCard key={ev.id} ev={ev} />)}
          </ul>
        </div>
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Newest units</h3>
          <div className="row">
            {(['all', 'writes', 'uses'] as const).map((f) => (
              <button key={f} className={`btn ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
        </div>
        <ul className="dots" style={{ marginTop: 10 }}>
          {recentUnits.map((u) => (
            <li key={u.id}>
              <span className="badge">{u.type}</span>{' '}
              <b>{u.title}</b>{' '}
              <span className="muted">{relTime(u.updatedAt)} · {u.status}</span>
              <div className="muted">{u.summary}</div>
            </li>
          ))}
          {recentUnits.length === 0 && <li className="muted">No units yet.</li>}
        </ul>
      </div>

      <div className="panel">
        <h3>Full timeline ({filtered.length})</h3>
        <ul className="event-list">
          {filtered.map((ev) => <EventCard key={ev.id} ev={ev} />)}
        </ul>
      </div>
    </div>
  );
}
