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

  const cards: Array<[string, number]> = [
    ['Units', c.units], ['Active', c.unitsActive], ['Crystals', c.crystals],
    ['Traces', c.traces], ['Links', c.links], ['Sources', c.sources],
    ['Pending review', c.pendingReview], ['Sessions', c.sessions],
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

      <div className="panel">
        <h3>Types</h3>
        <div className="row">
          {Object.entries(stats.byType).map(([t, n]) => (
            <span key={t} className="badge">{t}: {n}</span>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Growth (units/day)</h3>
        {stats.perDay.length === 0 && <div className="muted">No data yet.</div>}
        {stats.perDay.map((d) => (
          <div key={d.day} className="row" style={{ marginBottom: 6 }}>
            <span style={{ width: 90 }} className="muted">{d.day}</span>
            <div style={{ flex: 1 }} className="bar"><i style={{ width: `${(d.units / maxUnits) * 100}%` }} /></div>
            <span>{d.units}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
