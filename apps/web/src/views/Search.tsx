import { useState } from 'react';
import { api } from '../api';
import type { RecallResult, SearchResult } from '../types';

export function Search() {
  const [query, setQuery] = useState('');
  const [budget, setBudget] = useState(4000);
  const [recall, setRecall] = useState<RecallResult | null>(null);
  const [kw, setKw] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      const [r, s] = await Promise.all([
        api.recall({ query, tokenBudget: budget }),
        api.search(query),
      ]);
      setRecall(r); setKw(s);
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!recall) return;
    await navigator.clipboard.writeText(recall.text);
    alert('Context block copied to clipboard');
  };

  return (
    <div className="grid">
      <form className="panel row" onSubmit={run}>
        <input style={{ flex: 1 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Question or topic — e.g. how is agent memory stored" />
        <label className="muted">budget
          <input type="number" value={budget} onChange={(e) => setBudget(Number(e.target.value))} style={{ width: 90, marginLeft: 6 }} />
        </label>
        <button className="btn primary" disabled={loading}>{loading ? '…' : 'Recall + Search'}</button>
      </form>

      {recall && (
        <div className="panel">
          <div className="row">
            <h3 style={{ margin: 0 }}>Context block</h3>
            <span className="badge">{recall.usedTokens} / {recall.budget} tokens</span>
            <span className="badge">{recall.grounded ? 'grounded' : 'no citations'}</span>
            <button className="btn" onClick={copy} style={{ marginLeft: 'auto' }}>Copy</button>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 10, borderRadius: 8 }}>{recall.text}</pre>
          <ul className="dots">
            {recall.items.map((it) => (
              <li key={it.unit.id}>
                <b>[{it.score.toFixed(2)}]</b> {it.unit.title} <span className="muted">({it.reason})</span><br />
                <span className="muted">{it.unit.summary}</span>
                {it.citations.map((c) => <span key={c.id} className="tag">{c.title}</span>)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {kw && (
        <div className="panel">
          <h3>Keyword search ({kw.items.length})</h3>
          <ul className="dots">
            {kw.items.map((it) => (
              <li key={it.unit.id}><b>{it.unit.title}</b> <span className="badge">{it.via}</span> <span className="muted">{(it.score).toFixed(2)}</span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
