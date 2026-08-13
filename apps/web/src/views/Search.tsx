import { useEffect, useState } from 'react';
import { api } from '../api';
import { Highlight } from '../components/Highlight';
import type { RecallResult, SearchResult, UnitStatus, UnitType } from '../types';

const CATEGORIES = ['code', 'infra', 'workflow', 'product', 'personal', 'research', 'meta', 'other'] as const;
const TYPES: UnitType[] = ['fact', 'decision', 'plan', 'procedure', 'preference', 'concept', 'lesson', 'question'];
const STATUSES: UnitStatus[] = ['pending', 'reviewed', 'archived', 'merged', 'flagged'];

export function Search({ initialQuery = '' }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [budget, setBudget] = useState(4000);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [fullText, setFullText] = useState(false);
  const [recall, setRecall] = useState<RecallResult | null>(null);
  const [kw, setKw] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const PAGE = 20;

  const runWith = async (q: string) => {
    if (!q.trim()) return;
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
        api.recall({ query: q, tokenBudget: budget }),
        api.search(q, { ...filter, limit: PAGE }),
      ]);
      setRecall(r); setKw(s);
    } finally {
      setLoading(false);
    }
  };

  const run = (e: React.FormEvent) => {
    e.preventDefault();
    runWith(query);
  };

  // Auto-run when the sidebar global search pushes a new keyword into this page.
  useEffect(() => {
    if (initialQuery.trim()) {
      setQuery(initialQuery);
      runWith(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const loadMore = async () => {
    if (!kw || !query.trim() || moreLoading) return;
    const filter = {
      status: status || undefined,
      type: type || undefined,
      category: category || undefined,
      tag: tag || undefined,
      fullText,
    };
    setMoreLoading(true);
    try {
      const s = await api.search(query, { ...filter, limit: PAGE, offset: kw.items.length });
      setKw({ ...s, items: [...kw.items, ...s.items] });
    } finally {
      setMoreLoading(false);
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
          <div className="row">
            <h3 style={{ margin: 0 }}>Keyword search ({kw.items.length}/{kw.total})</h3>
            <span className="badge">{kw.items.length === kw.total ? 'all results' : `${kw.total - kw.items.length} more`}</span>
          </div>
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
          {kw.items.length < kw.total && (
            <button className="btn" onClick={loadMore} disabled={moreLoading} style={{ marginTop: 8 }}>
              {moreLoading ? '…' : `Load ${Math.min(PAGE, kw.total - kw.items.length)} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
