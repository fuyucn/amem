import { useState } from 'react';
import { api } from '../api';
import type { RecallResult, SearchResult, UnitStatus, UnitType } from '../types';

const CATEGORIES = ['code', 'infra', 'workflow', 'product', 'personal', 'research', 'meta', 'other'] as const;
const TYPES: UnitType[] = ['fact', 'decision', 'plan', 'procedure', 'preference', 'concept', 'lesson', 'question'];
const STATUSES: UnitStatus[] = ['pending', 'reviewed', 'archived', 'merged', 'flagged'];

/** Wrap matched terms in <mark>. Falls back to plain text when no terms are provided. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})`,
    'gi',
  );
  // split() with one capture group inserts matched terms at odd indices.
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

export function Search() {
  const [query, setQuery] = useState('');
  const [budget, setBudget] = useState(4000);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [fullText, setFullText] = useState(false);
  const [recall, setRecall] = useState<RecallResult | null>(null);
  const [kw, setKw] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    const filter = {
      status: status || undefined,
      type: type || undefined,
      category: category || undefined,
      tag: tag || undefined,
      fullText,
    };
    setLoading(true);
    try {
      const [r, s] = await Promise.all([
        api.recall({ query, tokenBudget: budget }),
        api.search(query, filter),
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

      <div className="panel row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">status: all</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">type: all</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">category: all</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          style={{ width: 130 }} value={tag} onChange={(e) => setTag(e.target.value)}
          placeholder="tag (exact)"
        />
        <label className="muted" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={fullText} onChange={(e) => setFullText(e.target.checked)} />
          full body
        </label>
      </div>

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
              <li key={it.unit.id}>
                <b><Highlight text={it.unit.title} terms={it.terms} /></b>{' '}
                <span className="badge">{it.via}</span>{' '}
                <span className="muted">{(it.score).toFixed(2)}</span>
                <span className="muted">{it.unit.summary ? <><br /><Highlight text={it.unit.summary} terms={it.terms} /></> : null}</span>
                <span className="muted">{it.unit.category ? <><br />category: {it.unit.category}</> : null}</span>
                {it.unit.tags.map((t) => <span key={t} className="tag">{t}</span>)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
