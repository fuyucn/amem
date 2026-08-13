import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ActivityEvent, Stats } from '../types';

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.stats(), api.activity({ limit: 12 })])
      .then(([s, a]) => { setStats(s); setEvents(a); })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  if (error) return <div className="panel">Failed to load stats: {error}</div>;
  if (!stats) return <div className="panel">Loading…</div>;
  const c = stats.counts;
  const maxUnits = Math.max(1, ...stats.perDay.map((d) => d.units));
  const maxTraces = Math.max(1, ...stats.perDay.map((d) => d.traces));
  const typeTotal = Object.values(stats.byType).reduce((a, b) => a + b, 0) || 1;
  const catTotal = Object.values(stats.byCategory).reduce((a, b) => a + b, 0) || 1;

  const cards: Array<[string, number]> = [
    ['Units', c.units], ['Active', c.unitsActive], ['Crystals', c.crystals],
    ['Traces', c.traces], ['Links', c.links], ['Sources', c.sources],
    ['Pending review', c.pendingReview], ['Sessions', c.sessions],
  ];

  const flowStages: Array<{ name: string; count: number; desc: string; sink?: boolean }> = [
    { name: 'Sources', count: c.sources, desc: 'Imported docs / code / sessions' },
    { name: 'Traces', count: c.traces, desc: 'Raw ingested material' },
    { name: 'Units (L1)', count: c.units, desc: 'Atomic distilled memories' },
    { name: 'Links', count: c.links, desc: 'Typed cross-references' },
    { name: 'Crystals', count: c.crystals, desc: 'Consolidated core knowledge' },
    { name: 'Scenarios (L2)', count: c.scenarios, desc: 'Recurring situation packs' },
    { name: 'Assets (L3)', count: c.assets, desc: 'Skills · wiki · codegraph' },
    { name: 'Recall', count: stats.recallTokensDelivered, desc: 'Tokens delivered to agents', sink: true },
  ];

  return (
    <div className="grid">
      <div className="cards">
        {cards.map(([lbl, num]) => (
          <div className="card" key={lbl}>
            <div className="num">{num}</div>
            <div className="lbl">{lbl}</div>
          </div>
        ))}
        <div className="card"><div className="num">{stats.tokensSavedByDedup}</div><div className="lbl">Tokens saved (dedup)</div></div>
        <div className="card"><div className="num">{stats.tokenWasteAvoided}</div><div className="lbl">Token waste avoided</div></div>
        <div className="card"><div className="num">{stats.graph.nodeCount} / {stats.graph.linkCount}</div><div className="lbl">Graph nodes / edges</div></div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Knowledge pipeline (data flow)</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Material flows from raw sources through distillation to agent-facing memory.
        </p>
        <div className="flow">
          {flowStages.map((s, i) => (
            <span key={s.name} style={{ display: 'contents' }}>
              {i > 0 && <span className="flow-arrow">→</span>}
              <div className={s.sink ? 'flow-stage flow-sink' : 'flow-stage'}>
                <div className="flow-count">{s.count}</div>
                <div className="flow-name">{s.name}</div>
                <div className="flow-desc">{s.desc}</div>
              </div>
            </span>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Recent activity</h3>
        {events.length === 0 && <div className="muted">No activity yet — open the Activity tab after Codex writes or recalls memory.</div>}
        <ul className="event-list">
          {events.map((ev) => (
            <li key={ev.id} className="event-card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="badge">{ev.kind}</span>
                <span className="muted">{relTime(ev.createdAt)}</span>
              </div>
              <div className="event-summary">{ev.summary}</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="stat-grid">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Types</h3>
          {Object.entries(stats.byType)
            .sort(([, a], [, b]) => b - a)
            .map(([t, n]) => (
              <div className="dist-row" key={t}>
                <span className="dist-label">{t}</span>
                <div className="dist-bar"><i style={{ width: `${(n / typeTotal) * 100}%` }} /></div>
                <span className="dist-num">{n}</span>
                <span className="dist-pct">{Math.round((n / typeTotal) * 100)}%</span>
              </div>
            ))}
        </div>

        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Categories</h3>
          {Object.entries(stats.byCategory)
            .sort(([, a], [, b]) => b - a)
            .map(([cat, n]) => (
              <div className="dist-row" key={cat}>
                <span className="dist-label">{cat}</span>
                <div className="dist-bar"><i style={{ width: `${(n / catTotal) * 100}%` }} /></div>
                <span className="dist-num">{n}</span>
                <span className="dist-pct">{Math.round((n / catTotal) * 100)}%</span>
              </div>
            ))}
        </div>

        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Growth (per day)</h3>
          {stats.perDay.length === 0 && <div className="muted">No data yet.</div>}
          {stats.perDay.map((d) => (
            <div key={d.day} className="row" style={{ marginBottom: 8 }}>
              <span style={{ width: 90 }} className="muted">{d.day}</span>
              <div style={{ flex: 1, display: 'grid', gap: 3 }}>
                <div className="bar"><i style={{ width: `${(d.units / maxUnits) * 100}%` }} /></div>
                <div className="bar bar-trace"><i style={{ width: `${(d.traces / maxTraces) * 100}%` }} /></div>
              </div>
              <span className="num">{d.units}U</span>
              <span className="muted num">{d.traces}T</span>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Token economics</h3>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="muted">Dedup saved</span>
            <b className="num">{stats.tokensSavedByDedup.toLocaleString()}</b>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="muted">Recall delivered</span>
            <b className="num">{stats.recallTokensDelivered.toLocaleString()}</b>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">Waste avoided</span>
            <b className="num">{stats.tokenWasteAvoided.toLocaleString()}</b>
          </div>
          <p className="muted" style={{ marginBottom: 0, marginTop: 10, fontSize: 12 }}>
            Dedup skips re-adding known knowledge; recall delivers only relevant context instead of raw history.
          </p>
        </div>
      </div>
    </div>
  );
}
