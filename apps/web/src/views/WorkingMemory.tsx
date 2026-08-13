import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/PageHead';
import type { WorkingMemory as WM } from '../types';

export function WorkingMemory() {
  const [wm, setWm] = useState<WM | null>(null);
  const [error, setError] = useState('');

  const load = () => api.workingMemory().then(setWm).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { load(); }, []);

  return (
    <div className="grid">
      <PageHead
        title="Working memory"
        sub="Today's attention-prefetch briefing — the most relevant knowledge for a fresh agent session."
      />
      <div className="panel">
        <div className="row">
          <h3 style={{ margin: 0 }}>Working memory</h3>
          {wm && <span className="badge">{wm.date} · {wm.tokenCount} tokens</span>}
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={load}>Refresh</button>
        </div>
        <p className="muted">Today's attention-prefetch briefing: the most relevant knowledge for a fresh session.</p>
        {error && <div className="muted">Error: {error}</div>}
        <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 12, borderRadius: 8, lineHeight: 1.6 }}>{wm?.text ?? 'Loading…'}</pre>
      </div>
      <div className="panel">
        <h3 style={{ margin: 0 }}>Selected units</h3>
        <ul className="dots">
          {(wm?.selected ?? []).map((u) => (
            <li key={u.id}><span className="badge">{u.type}</span> {u.title} <span className="muted">· {(u.importance * 100).toFixed(0)}% important · {(u.decay * 100).toFixed(0)}% decay</span></li>
          ))}
        </ul>
      </div>
    </div>
  );
}
