import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/PageHead';
import type { Zone, ZoneKind, ZoneMember, ZoneVisibility } from '../types';

const KIND_LABEL: Record<ZoneKind, string> = {
  inbox: 'Inbox',
  shared: 'Shared',
  personal: 'Personal',
  project: 'Project',
};

const VISIBILITY_LABEL: Record<ZoneVisibility, string> = {
  workspace: 'Workspace',
  members: 'Members',
  private: 'Private',
};

const EMPTY_FORM = { slug: '', name: '', kind: 'project' as ZoneKind, visibility: '' as ZoneVisibility | '' };

export function Zones() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [members, setMembers] = useState<Record<string, ZoneMember[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState(EMPTY_FORM);
  const [rename, setRename] = useState<Record<string, string>>({});
  const [memberEmail, setMemberEmail] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .zones()
      .then(setZones)
      .catch((e) => setError(String((e as Error).message || e)));

  useEffect(() => {
    load();
  }, []);

  const loadMembers = async (zone: Zone) => {
    try {
      const list = await api.zoneMembers(zone.id);
      setMembers((m) => ({ ...m, [zone.id]: list }));
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const toggleMembers = (zone: Zone) => {
    const next = !expanded[zone.id];
    setExpanded((x) => ({ ...x, [zone.id]: next }));
    if (next && !members[zone.id]) loadMembers(zone);
  };

  const createZone = async () => {
    if (!form.slug.trim()) return setError('slug is required');
    setBusy(true);
    try {
      await api.createZone({
        slug: form.slug.trim(),
        name: form.name.trim() || undefined,
        kind: form.kind,
        visibility: form.visibility || undefined,
      });
      setForm(EMPTY_FORM);
      setInfo(`Zone "${form.slug}" created`);
      await load();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const updateZone = async (zone: Zone, patch: Parameters<typeof api.updateZone>[1]) => {
    try {
      await api.updateZone(zone.id, patch);
      setInfo(`Zone "${zone.slug}" updated`);
      await load();
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const removeZone = async (zone: Zone) => {
    if (!window.confirm(`Delete zone "${zone.slug}"? It must be empty.`)) return;
    try {
      await api.deleteZone(zone.id);
      setInfo(`Zone "${zone.slug}" deleted`);
      await load();
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const addMember = async (zone: Zone) => {
    const email = memberEmail[zone.id]?.trim();
    if (!email) return;
    try {
      await api.addZoneMember(zone.id, { email, role: 'reader' });
      setMemberEmail((m) => ({ ...m, [zone.id]: '' }));
      setInfo(`Member ${email} added to "${zone.slug}"`);
      await loadMembers(zone);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const removeMember = async (zone: Zone, userId: string) => {
    try {
      await api.removeZoneMember(zone.id, userId);
      await loadMembers(zone);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const recompute = async () => {
    try {
      const r = await api.recomputeZones();
      setInfo(
        r.skippedOffline
          ? 'Recompute skipped: offline embedder (no semantic centroids)'
          : `Recompute done: ${r.updated} zone(s) updated`,
      );
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const sorted = [...zones].sort((a, b) => {
    const order: Record<ZoneKind, number> = { inbox: 0, personal: 1, shared: 2, project: 3 };
    return (order[a.kind] ?? 4) - (order[b.kind] ?? 4) || a.slug.localeCompare(b.slug);
  });

  return (
    <div>
      <PageHead
        title="Zones"
        sub="Workspace partitions · who can read and write what"
      >
          <button className="btn" onClick={recompute} title="Recompute zone embedding centroids">
            Recompute centroids
          </button>
      </PageHead>

      {error && <div className="err" role="alert">{error}</div>}
      {info && <div className="okmsg" role="status">{info}</div>}

      <div className="card">
        <div className="card-head">New zone</div>
        <div className="row">
          <input
            placeholder="slug (e.g. frontend)"
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
          />
          <input
            placeholder="name (optional)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as ZoneKind })}
          >
            {(Object.keys(KIND_LABEL) as ZoneKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </select>
          <select
            value={form.visibility || ''}
            onChange={(e) => setForm({ ...form, visibility: e.target.value as ZoneVisibility })}
          >
            <option value="">default for kind</option>
            {(Object.keys(VISIBILITY_LABEL) as ZoneVisibility[]).map((v) => (
              <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>
            ))}
          </select>
          <button className="btn primary" onClick={createZone} disabled={busy}>
            {busy ? 'Creating…' : 'Create zone'}
          </button>
        </div>
      </div>

      <div className="cards zone-cards">
        {sorted.length === 0 && <div className="empty-note">No zones yet — create one above.</div>}
        {sorted.map((zone) => (
          <div className="card zone-card" key={zone.id}>
            <div className="row between">
              <div>
                <span className="badge">{KIND_LABEL[zone.kind]}</span>{' '}
                <strong>{zone.name}</strong>
                <span className="mono"> {zone.slug}</span>
              </div>
              <div className="row">
                <span className={`badge${zone.status === 'active' ? '' : ' muted'}`}>
                  {zone.status}
                </span>
                <span className="badge">{VISIBILITY_LABEL[zone.visibility]}</span>
              </div>
            </div>
            <div className="muted small">
              {zone.unitCount} unit(s) · {zone.memberCount} member(s)
              {zone.ownerUserId ? ` · owner ${zone.ownerUserId}` : ''}
            </div>
            {zone.description ? <div className="small">{zone.description}</div> : null}

            <div className="row">
              <input
                className="grow"
                placeholder="rename…"
                value={rename[zone.id] ?? zone.name}
                onChange={(e) => setRename((r) => ({ ...r, [zone.id]: e.target.value }))}
              />
              <button
                className="btn"
                onClick={() => updateZone(zone, { name: rename[zone.id]?.trim() || zone.name })}
              >
                Rename
              </button>
              <button
                className="btn"
                onClick={() => updateZone(zone, { status: zone.status === 'active' ? 'archived' : 'active' })}
              >
                {zone.status === 'active' ? 'Archive' : 'Activate'}
              </button>
              <button className="btn danger" onClick={() => removeZone(zone)}>Delete</button>
            </div>

            <button className="btn ghost small" onClick={() => toggleMembers(zone)}>
              {expanded[zone.id] ? 'Hide members' : 'Members'}
            </button>
            {expanded[zone.id] && (
              <div className="panel">
                <div className="row">
                  <input
                    className="grow"
                    placeholder="member email…"
                    value={memberEmail[zone.id] ?? ''}
                    onChange={(e) => setMemberEmail((m) => ({ ...m, [zone.id]: e.target.value }))}
                  />
                  <button className="btn" onClick={() => addMember(zone)}>Add reader</button>
                </div>
                <ul className="list">
                  {(members[zone.id] ?? []).map((m) => (
                    <li key={m.userId} className="row between">
                      <span>
                        <span className="mono">{m.userId}</span>{' '}
                        <span className="badge">{m.role}</span>
                      </span>
                      <button className="btn small danger" onClick={() => removeMember(zone, m.userId)}>
                        Remove
                      </button>
                    </li>
                  ))}
                  {(members[zone.id] ?? []).length === 0 && (
                    <li className="muted small">No explicit members (workspace-visible zones need none).</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
