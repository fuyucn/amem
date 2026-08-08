import { useState } from 'react';
import { api } from '../api';
import type { IngestResult, Trace } from '../types';

export function Traces() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [result, setResult] = useState<IngestResult | null>(null);

  const load = () => api.traces().then(setTraces);
  void load;

  const doIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    const r = await api.ingest({ title: title || 'Ingested note', content });
    setResult(r);
    load();
    setContent('');
  };

  return (
    <div className="grid">
      <form className="panel" onSubmit={doIngest}>
        <h3 style={{ marginTop: 0 }}>Ingest new material</h3>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={{ marginBottom: 6, width: '100%' }} />
        <textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)}
          placeholder="Paste a conversation transcript, doc, or notes. Amem will store the trace and distill atomic units." />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" type="submit">Ingest</button>
          <button className="btn" type="button" onClick={load}>Refresh traces</button>
        </div>
        {result && (
          <div className="panel" style={{ marginTop: 10 }}>
            <b>Extracted {result.units.length} units</b> (dedup saved {result.tokensSavedByDedup} tokens)
            <ul className="dots">
              {result.units.map((u) => <li key={u.id}><span className="badge">{u.type}</span> {u.title}</li>)}
            </ul>
          </div>
        )}
      </form>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Traces</h3>
        <ul className="dots">
          {traces.map((t) => (
            <li key={t.id} onClick={() => setOpenId(openId === t.id ? null : t.id)}>
              <b>{t.title}</b> <span className="badge">{t.tokenCount} tok</span> <span className="muted">{t.createdAt.slice(0, 16)}</span>
              {openId === t.id && <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 8, borderRadius: 6, marginTop: 6 }}>{t.content}</pre>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
