import { useEffect, useState } from 'react';
import { api } from '../api';
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
    <div className="panel">
      <div className="row">
        <h3 style={{ margin: 0 }}>Review queue</h3>
        <span className="badge">{items.length} pending</span>
        <span className="muted" style={{ marginLeft: 'auto' }}>{message}</span>
      </div>
      <p className="muted">Auto-extracted units wait here for your approval before they become active knowledge.</p>
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
  );
}
