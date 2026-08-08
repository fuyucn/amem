import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Link, Unit, UnitSummary } from '../types';

const CATEGORIES = ['code', 'infra', 'workflow', 'product', 'personal', 'research', 'meta', 'other'] as const;
const BATCH_ACTIONS: Array<{ action: 'archive' | 'restore' | 'delete' | 'accept'; label: string }> = [
  { action: 'archive', label: 'Archive' },
  { action: 'restore', label: 'Restore' },
  { action: 'accept', label: 'Accept' },
  { action: 'delete', label: 'Delete' },
];

interface UnitsProps {
  unitId?: string | null;
  onSelectUnit?: (id: string) => void;
}

export function Units({ unitId = null, onSelectUnit }: UnitsProps) {
  const [units, setUnits] = useState<UnitSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(unitId);
  const [unit, setUnit] = useState<Unit | null>(null);
  const [linksIn, setLinksIn] = useState<Link[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [limit] = useState(50);
  const [showNew, setShowNew] = useState(false);

  const [form, setForm] = useState({ type: 'fact', title: '', summary: '', body: '', tags: '' });

  const load = () =>
    api.units({ status, category: category === 'unclassified' ? '' : category, limit })
      .then((list) => {
        setUnits(category === 'unclassified' ? list.filter((u) => !u.category) : list);
        setSelected(new Set());
      })
      .catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { load(); }, [status, category, limit]);

  useEffect(() => {
    setSelectedId(unitId);
  }, [unitId]);

  useEffect(() => {
    if (!selectedId) { setUnit(null); setLinksIn([]); return; }
    api.unit(selectedId).then(setUnit).catch(() => setUnit(null));
    api.linksForUnit(selectedId).then(setLinksIn).catch(() => setLinksIn([]));
  }, [selectedId]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.createUnit({
      type: form.type as Unit['type'], title: form.title, summary: form.summary, body: form.body,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    setShowNew(false); setForm({ type: 'fact', title: '', summary: '', body: '', tags: '' });
    load();
  };

  const review = async (action: 'accept' | 'discard') => {
    if (!unit) return;
    await api.reviewUnit(unit.id, action);
    setUnit({ ...unit, status: action === 'accept' ? 'reviewed' : 'archived' });
    load();
  };

  const remove = async () => {
    if (!unit) return;
    await api.deleteUnit(unit.id);
    setSelectedId(null); load();
    onSelectUnit?.('');
  };

  const setCategoryOf = async (id: string, cat: string) => {
    if (!cat) return;
    const existing = unit && unit.id === id ? unit : await api.unit(id);
    await api.updateUnit(id, { labels: { ...existing.labels, category: cat } }, `set-category:${cat}`);
    if (unit && unit.id === id) setUnit({ ...unit, labels: { ...unit.labels, category: cat } });
    load();
  };

  const classify = async (mode: 'rules' | 'auto' = 'auto') => {
    setBusy(true); setError('');
    try {
      const r = await api.classifyUnits({ mode });
      setError(`Classified ${r.classified}/${r.examined} examined units (${Object.entries(r.byCategory ?? {}).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}).`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const batch = async (action: 'archive' | 'restore' | 'delete' | 'accept') => {
    if (selected.size === 0) return;
    setBusy(true); setError('');
    try {
      const r = await api.batchUnits({ ids: [...selected], action });
      setError(`${action}: ${r.affected} affected, ${r.skipped} skipped.`);
      setSelected(new Set());
      if (action === 'delete') setSelectedId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const select = (id: string) => {
    setSelectedId(id);
    onSelectUnit?.(id);
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: '340px 1fr' }}>
      <div className="panel">
        <div className="row">
          <b>Units</b>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all</option>
            <option value="pending">pending</option>
            <option value="reviewed">reviewed</option>
            <option value="archived">archived</option>
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">category: all</option>
            <option value="unclassified">unclassified</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setShowNew((v) => !v)}>+ New</button>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn" disabled={busy} onClick={() => classify('auto')}>Classify unclassified</button>
          {BATCH_ACTIONS.map(({ action, label }) => (
            <button key={action} className="btn" disabled={busy || selected.size === 0} onClick={() => batch(action)}>
              {label} ({selected.size})
            </button>
          ))}
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          {selected.size > 0 ? `${selected.size} selected` : 'Select units to batch-manage, or classify new ones.'}
        </div>
        {showNew && (
          <form onSubmit={create} className="panel" style={{ marginTop: 10 }}>
            <input placeholder="title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ marginBottom: 6, width: '100%' }} />
            <input placeholder="summary" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} style={{ marginBottom: 6, width: '100%' }} />
            <textarea rows={4} placeholder="body" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} style={{ marginBottom: 6 }} />
            <div className="row">
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {['fact', 'decision', 'plan', 'procedure', 'preference', 'concept', 'lesson', 'question'].map((t) => <option key={t}>{t}</option>)}
              </select>
              <input placeholder="tags,comma" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              <button className="btn primary" type="submit">Save</button>
            </div>
          </form>
        )}
        {error && <div className="muted">{error}</div>}
        <ul className="dots">
          {units.map((u) => {
            const cat = u.category ?? '';
            return (
              <li key={u.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={selected.has(u.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(u.id)}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => select(u.id)}>
                  <span className="badge">{u.type}</span>
                  {cat && <span className="badge" style={{ background: 'var(--accent2)' }}>{cat}</span>}
                  {' '}{u.title}
                  <div className="muted">{u.summary}</div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="panel">
        {!unit && <div className="muted">Select a unit to inspect.</div>}
        {unit && (
          <>
            <div className="row">
              <h3 style={{ margin: 0 }}>{unit.title}</h3>
              <span className="badge">{unit.type}</span>
              {typeof unit.labels?.category === 'string' && <span className="badge" style={{ background: 'var(--accent2)' }}>{unit.labels.category}</span>}
              <span className="badge">{unit.form}</span>
              <span className="badge">{unit.status}</span>
              <span className="badge">v{unit.version}</span>
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="muted">Category:</span>
              <select value={typeof unit.labels?.category === 'string' ? unit.labels.category : ''} onChange={(e) => setCategoryOf(unit.id, e.target.value)}>
                <option value="">unset</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <p className="muted">{unit.summary}</p>
            {unit.tags.map((t) => <span key={t} className="tag">{t}</span>)}
            <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 10, borderRadius: 8 }}>{unit.body}</pre>
            <div className="muted">sources: {unit.sourceCount} · importance {unit.importance.toFixed(2)} · decay {unit.decay.toFixed(2)} · confidence {(unit.confidence * 100).toFixed(0)}%</div>
            <div className="row" style={{ marginTop: 10 }}>
              {unit.status === 'pending' && <button className="btn primary" onClick={() => review('accept')}>Accept</button>}
              {unit.status === 'pending' && <button className="btn" onClick={() => review('discard')}>Discard</button>}
              <button className="btn" onClick={remove} style={{ marginLeft: 'auto' }}>Delete</button>
            </div>
            <h4>Links ({linksIn.length})</h4>
            <ul className="dots">
              {linksIn.map((l) => (
                <li key={l.id}>
                  <span className="badge">{l.relation}</span>
                  {l.sourceUnitId === unit.id ? `→ ${l.targetUnitId}` : `← ${l.sourceUnitId}`}
                  <span className="muted"> · {(l.confidence * 100).toFixed(0)}%{l.auto ? ' (auto)' : ''}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
