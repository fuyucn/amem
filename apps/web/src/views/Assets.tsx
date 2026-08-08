import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Asset, AssetKind, AssetVisibility } from '../types';

const KINDS: Array<AssetKind | ''> = ['', 'skill', 'wiki', 'codegraph', 'prompt'];
const VISIBILITIES: AssetVisibility[] = ['private', 'workspace', 'team', 'public'];

export function Assets() {
  const [items, setItems] = useState<Asset[]>([]);
  const [kind, setKind] = useState<AssetKind | ''>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // New-asset form (wiki / prompt authoring)
  const [showForm, setShowForm] = useState(false);
  const [newKind, setNewKind] = useState<AssetKind>('wiki');
  const [newName, setNewName] = useState('');
  const [newBody, setNewBody] = useState('');

  const load = () => api.assets(kind ? { kind } : {}).then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, [kind]);

  const extract = async () => {
    setBusy(true);
    setMessage('Extracting Skill assets from procedure/lesson units…');
    try {
      const r = await api.extractSkills({});
      setMessage(`+${r.created} skill(s) created, ${r.updated} updated`);
      load();
    } catch (e) {
      setMessage(`Extract failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const extractWiki = async () => {
    setBusy(true);
    setMessage('Aggregating doc-sourced units into Wiki pages…');
    try {
      const r = await api.extractWiki({});
      setMessage(`+${r.created} wiki page(s) created, ${r.updated} updated`);
      load();
    } catch (e) {
      setMessage(`Wiki extract failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const extractCodegraph = async () => {
    setBusy(true);
    setMessage('Aggregating imported code units into CodeGraph…');
    try {
      const r = await api.extractCodegraph({});
      setMessage(`+${r.created} codegraph asset(s) created, ${r.updated} updated`);
      load();
    } catch (e) {
      setMessage(`CodeGraph extract failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.createAsset({
        kind: newKind,
        name: newName,
        description: newBody.slice(0, 160),
        body: newBody,
        trigger: '',
        content: '',
        tags: [],
        sourceUnitIds: [],
        status: 'draft',
      });
      setShowForm(false);
      setNewName('');
      setNewBody('');
      load();
    } catch (err) {
      setMessage(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const publish = async (a: Asset) => {
    await api.updateAsset(a.id, { status: a.status === 'published' ? 'reviewed' : 'published' });
    load();
  };

  const setVisibility = async (a: Asset, visibility: AssetVisibility) => {
    await api.updateAsset(a.id, { visibility });
    load();
  };

  const setBinding = async (a: Asset, raw: string) => {
    const boundAgents = raw.split(',').map((s) => s.trim()).filter(Boolean);
    await api.updateAsset(a.id, { boundAgents });
    load();
  };

  return (
    <div className="grid">
      <div className="panel">
        <div className="row">
          <h3 style={{ margin: 0 }}>Assets</h3>
          <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind | '')}>
            {KINDS.map((k) => <option key={k || 'all'} value={k}>{k || 'all kinds'}</option>)}
          </select>
          <span className="muted" style={{ marginLeft: 'auto' }}>{message}</span>
        </div>
        <p className="muted">
          Portable, reviewable memory assets: Skills (reusable procedures), Wiki pages,
          CodeGraph indexes, and Prompts. Decoupled from any agent framework.
        </p>
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="btn primary" onClick={extract} disabled={busy}>
            {busy ? 'Extracting…' : 'Extract skills from units'}
          </button>
          <button className="btn" onClick={extractWiki} disabled={busy}>
            Extract wiki pages
          </button>
          <button className="btn" onClick={extractCodegraph} disabled={busy}>
            Extract code graph
          </button>
          <button className="btn" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : 'New wiki / prompt'}
          </button>
        </div>
        {showForm && (
          <form className="panel" onSubmit={create} style={{ marginBottom: 10 }}>
            <div className="row">
              <select value={newKind} onChange={(e) => setNewKind(e.target.value as AssetKind)}>
                <option value="wiki">wiki</option>
                <option value="prompt">prompt</option>
                <option value="skill">skill</option>
              </select>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" style={{ flex: 1 }} />
            </div>
            <textarea rows={6} value={newBody} onChange={(e) => setNewBody(e.target.value)} placeholder="Markdown body (steps for skills, page text for wiki)…" />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" type="submit">Create</button>
            </div>
          </form>
        )}
        <ul className="dots">
          {items.length === 0 && <li className="muted">No assets. Extract skills from units or author a wiki page.</li>}
          {items.map((a) => (
            <li key={a.id} onClick={() => setOpenId(openId === a.id ? null : a.id)}>
              <div className="row">
                <span className="badge">{a.kind}</span>
                <b>{a.name}</b>
                <span className="badge">{a.status}</span>
                <span className="badge">{a.visibility}</span>
                <span className="badge">v{a.version}</span>
                <span className="muted" style={{ marginLeft: 'auto' }}>{a.updatedAt.slice(0, 16)}</span>
              </div>
              <div className="muted">{a.description}</div>
              {openId === a.id && (
                <div className="panel" style={{ marginTop: 8, marginBottom: 8 }}>
                  {a.trigger && <p><b>Trigger:</b> {a.trigger}</p>}
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{a.body || a.content}</pre>
                  <div className="row" style={{ marginTop: 6 }}>
                    {a.tags.map((t) => <span key={t} className="badge">{t}</span>)}
                    <select
                      value={a.visibility}
                      onChange={(e) => { e.stopPropagation(); setVisibility(a, e.target.value as AssetVisibility); }}
                      title="Who may route to this asset"
                    >
                      {VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                    <input
                      defaultValue={a.boundAgents.join(', ')}
                      onBlur={(e) => setBinding(a, e.target.value)}
                      placeholder="bound agents (comma-separated)"
                      style={{ flex: 1, minWidth: 160 }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button className="btn" onClick={(e) => { e.stopPropagation(); publish(a); }} style={{ marginLeft: 'auto' }}>
                      {a.status === 'published' ? 'Unpublish' : 'Publish'}
                    </button>
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
