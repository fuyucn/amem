import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/PageHead';
import type { ImportSourcesResult, UnitSummary, Zone } from '../types';

const ACCEPTED = '.pdf,.md,.markdown,.txt';

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Review() {
  const [items, setItems] = useState<UnitSummary[]>([]);
  const [message, setMessage] = useState('');
  const [zones, setZones] = useState<Zone[]>([]);
  const [zone, setZone] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [batch, setBatch] = useState<ImportSourcesResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => api.units({ status: 'pending' }).then(setItems);
  const loadZones = () => api.zones().then((zs) => setZones(zs)).catch(() => setZones([]));
  useEffect(() => { load(); loadZones(); }, []);

  const act = async (id: string, action: 'accept' | 'discard') => {
    await api.reviewUnit(id, action);
    setItems((prev) => prev.filter((u) => u.id !== id));
    setMessage(`${action === 'accept' ? 'Accepted' : 'Discarded'} a unit`);
  };

  const upload = useCallback(async (file: File) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setMessage(`File too large (${humanBytes(file.size)}): max 20 MB`);
      return;
    }
    setBusy(true);
    setMessage('');
    setBatch(null);
    try {
      const r = await api.uploadFile(file, zone || undefined);
      setBatch(r);
      setMessage(`Imported ${file.name} → ${r.units} unit(s), ${r.files} file(s)${r.ocrPages ? ` (${r.ocrPages} OCR pages)` : ''}`);
      load();
    } catch (e) {
      setMessage(`Import failed: ${String((e as Error).message ?? e)}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [zone]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  };

  return (
    <div className="grid">
      <PageHead
        title="Review"
        sub="Upload files (pdf/md/txt) to distill into knowledge, or approve units extracted by the pipeline."
      >
        <span className="legend-chip">{items.length} pending</span>
        {message && <span className="muted">{message}</span>}
      </PageHead>

      <div
        className={`panel ${dragOver ? 'drag-over' : ''}`}
        style={{
          border: '1.5px dashed var(--muted)',
          borderRadius: 12,
          padding: 22,
          cursor: 'pointer',
          textAlign: 'center',
        }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
        />
        <div className="row" style={{ justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
          <b>{busy ? 'Importing…' : dragOver ? 'Drop to import' : 'Drop a file here or click to browse'}</b>
          <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            zone:
            <select
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              disabled={busy}
            >
              <option value="">auto</option>
              {zones.map((z) => <option key={z.id} value={z.slug}>{z.name || z.slug}</option>)}
            </select>
          </label>
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          PDF (text layer, OCR fallback if configured) · Markdown · plain text · up to 20 MB
        </div>
        {batch && (
          <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <span className="legend-chip">{batch.units} units</span>
            <span className="legend-chip">{batch.sources} sources</span>
            <span className="legend-chip">{batch.files} file</span>
            {batch.ocrPages ? <span className="legend-chip">{batch.ocrPages} OCR pages</span> : null}
          </div>
        )}
      </div>

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
