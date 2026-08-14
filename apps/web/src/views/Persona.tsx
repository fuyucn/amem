import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/PageHead';
import type { Persona } from '../types';

export function PersonaView() {
  const [persona, setPersona] = useState<Persona | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = () => api.persona().then((p) => setPersona(p)).catch(() => setPersona(null));
  useEffect(() => { load(); }, []);

  const refresh = async () => {
    setBusy(true);
    setMessage('Rebuilding the L3 persona profile…');
    try {
      const r = await api.refreshLayers({ forcePersona: true });
      setMessage(`Persona ${r.personaUpdated ? 'updated' : 'unchanged'} (scenarios +${r.scenariosCreated})`);
      load();
    } catch (e) {
      setMessage(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const chars = persona?.content.length ?? 0;
  return (
    <div className="grid">
      <PageHead
        title="Persona"
        sub="L3 profile — the standing character of this memory: what matters, what to avoid, how to behave."
      />
      <div className="panel">
        <div className="row">
          <h3 style={{ margin: 0 }}>L3 — Persona</h3>
          {persona && <span className="badge">v{persona.version}</span>}
          <span className="muted" style={{ marginLeft: 'auto' }}>{message}</span>
        </div>
        <p className="muted">
          Long-term profile of this workspace: identity, preferences, working style.
          Kept under ~2000 chars so it is cheap to bootstrap any agent&apos;s context.
          {persona && ` ${chars} chars, updated ${persona.updatedAt.slice(0, 16)}.`}
        </p>
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="btn primary" onClick={refresh} disabled={busy}>
            {busy ? 'Rebuilding…' : 'Rebuild persona'}
          </button>
          <button className="btn" onClick={load}>Reload</button>
        </div>
        {persona ? (
          <div className="panel">
            <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{persona.content}</pre>
          </div>
        ) : (
          <p className="muted">No persona yet. Ingest knowledge and rebuild.</p>
        )}
      </div>
    </div>
  );
}
