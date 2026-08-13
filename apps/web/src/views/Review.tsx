import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/PageHead';
import type { UnitSummary } from '../types';

export function Review() {
  const [items, setItems] = useState<UnitSummary[]>([]);
  const [message, setMessage] = useState('');

  const load = () => api.units({ status: 'pending' }).then(setItems);
  useEffect(() => { load(); }, []);

  const act = async (id: string, action: 'accept' | 'discard') => {
    await api.reviewUnit(id, action);
    setItems((prev) => prev.filter((u) => u.id !== id));
    setMessage(`${action === 'accept' ? 'Accepted' : 'Discarded'} a unit`);
  };

  return (
    <div className="grid">
      <PageHead
        title="Review"
        sub="Auto-extracted units wait here for approval before they become active knowledge."
      >
        <span className="legend-chip">{items.length} pending</span>
        {message && <span className="muted">{message}</span>}
      </PageHead>
      <div className="panel">
        <ul className="dots">
        {items.length === 0 && <li className="muted">Nothing pending. Ingest content to create units.</li>}
        {items.map((u) => (
          <li key={u.id}>
            <span className="badge">{u.type}</span> <b>{u.title}</b>
            <div className="muted">{u.summary}</div>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn primary" onClick={() => act(u.id, 'accept')}>Accept</button>
              <button className="btn" onClick={() => act(u.id, 'discard')}>Discard</button>
            </div>
          </li>
        ))}
      </ul>
      </div>
    </div>
  );
}
