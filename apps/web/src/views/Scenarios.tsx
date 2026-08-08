import { useEffect, useState } from 'react';
import { api } from '../api';
import type { LayerRefreshResult, Scenario } from '../types';

export function Scenarios() {
  const [items, setItems] = useState<Scenario[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = () =>
    api.scenarios({ sort: 'heat' })
      .then(setItems)
      .catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  const refresh = async () => {
    setBusy(true);
    setMessage('Consolidating L1 units into L2 scenario blocks…');
    try {
      const r: LayerRefreshResult = await api.refreshLayers({ mode: 'fast' });
      setMessage(
        `+${r.scenariosCreated} scenario(s), ${r.scenariosUpdated} updated, persona ${r.personaUpdated ? 'updated' : 'unchanged'}, +${r.skillsCreated} skill(s)`,
      );
      load();
    } catch (e) {
      setMessage(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid">
      <div className="panel">
        <div className="row">
          <h3 style={{ margin: 0 }}>L2 — Scenarios</h3>
          <span className="badge">{items.length}</span>
          <span className="muted" style={{ marginLeft: 'auto' }}>{message}</span>
        </div>
        <p className="muted">
          Compact project/area knowledge blocks consolidated from many L1 units. Agents
          load these as fast context (L2) and drill into precise units (L1) only when needed.
        </p>
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="btn primary" onClick={refresh} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh layers'}
          </button>
          <button className="btn" onClick={load}>Reload</button>
        </div>
        <ul className="dots">
          {items.length === 0 && <li className="muted">No scenarios yet. Ingest knowledge, then run “Refresh layers”.</li>}
          {items.map((s) => (
            <li key={s.id} onClick={() => setOpenId(openId === s.id ? null : s.id)}>
              <div className="row">
                <b>{s.title}</b>
                {s.heat ? <span className="badge heat">{heatEmoji(s.heat)} {s.heat}</span> : null}
                <span className="badge">{s.status}</span>
                <span className="badge">v{s.version}</span>
                <span className="muted">{s.sourceUnitIds.length} source unit(s)</span>
                <span className="muted" style={{ marginLeft: 'auto' }}>{s.updatedAt.slice(0, 16)}</span>
              </div>
              <div className="muted">{s.summary}</div>
              {openId === s.id && (
                <div className="panel" style={{ marginTop: 8, marginBottom: 8 }}>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{s.content}</pre>
                  <div className="row" style={{ marginTop: 6 }}>
                    {s.tags.map((t) => <span key={t} className="badge">{t}</span>)}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function heatEmoji(heat: number): string {
  if (heat >= 1000) return '🔥🔥🔥🔥🔥';
  if (heat >= 500) return '🔥🔥🔥🔥';
  if (heat >= 100) return '🔥🔥🔥';
  if (heat >= 50) return '🔥🔥';
  if (heat >= 10) return '🔥';
  return '';
}
