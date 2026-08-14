import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/PageHead';
import type { LibraryTreeNode } from '../types';

interface LibraryProps {
  onNavigate: (zoneId: string, agent: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  personal: 'personal',
  shared: 'shared',
  project: 'project',
};

export function Library({ onNavigate }: LibraryProps) {
  const [tree, setTree] = useState<LibraryTreeNode[]>([]);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = () =>
    api.libraryTree()
      .then(setTree)
      .catch((e) => setError(String(e.message ?? e)));

  useEffect(() => { load(); }, []);

  const stats = useMemo(() => {
    const agents = new Map<string, number>();
    let units = 0;
    for (const zone of tree) {
      units += zone.unitCount;
      for (const a of zone.agents) agents.set(a.agent, (agents.get(a.agent) ?? 0) + a.count);
    }
    return {
      zones: tree.length,
      units,
      agents: [...agents.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [tree]);

  const toggle = (zoneId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId); else next.add(zoneId);
      return next;
    });
  };

  return (
    <div>
      <PageHead
        title="Library"
        sub="Directory of your memory — browse by zone, then drill into the agents and sources that wrote each unit."
      />
      <div className="grid" style={{ gridTemplateColumns: '1fr 300px' }}>
        <div className="panel">
          {error && <div className="muted">{error}</div>}
          {tree.length === 0 && !error && (
            <div className="empty-note">No zones yet. Create a zone, then agents will appear here as they write memory.</div>
          )}
          {tree.map((zone) => {
            const isCollapsed = collapsed.has(zone.zoneId);
            return (
              <div key={zone.zoneId} style={{ marginBottom: 10 }}>
                <div
                  className="row"
                  style={{ cursor: 'pointer', padding: '8px 10px', borderRadius: 8, background: 'var(--panel2)' }}
                  onClick={() => toggle(zone.zoneId)}
                  title="Click to expand / collapse"
                >
                  <span style={{ width: 14, display: 'inline-block' }}>{isCollapsed ? '▸' : '▾'}</span>
                  <b>{zone.name || zone.slug}</b>
                  <span className="badge badge-zone">{KIND_LABEL[zone.kind] ?? zone.kind}</span>
                  <span className="badge">{zone.visibility}</span>
                  <span className="muted">{zone.unitCount} units</span>
                  <button
                    className="btn"
                    style={{ marginLeft: 'auto', padding: '2px 10px' }}
                    onClick={(e) => { e.stopPropagation(); onNavigate(zone.zoneId, ''); }}
                    title="Filter Units to this zone"
                  >
                    Open
                  </button>
                </div>
                {!isCollapsed && (
                  <div style={{ paddingLeft: 24, marginTop: 6 }}>
                    <div className="muted" style={{ margin: '6px 0 4px' }}>Agents</div>
                    {zone.agents.length === 0 && <div className="muted" style={{ paddingLeft: 8 }}>— no agent-tagged units —</div>}
                    <ul className="dots">
                      {zone.agents.map((a) => (
                        <li key={a.agent} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <a
                            href={`/units?zone=${encodeURIComponent(zone.zoneId)}&agent=${encodeURIComponent(a.agent)}`}
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                              e.preventDefault();
                              onNavigate(zone.zoneId, a.agent);
                            }}
                          >
                            <span className="badge badge-agent">{a.agent}</span>
                          </a>
                          <span className="muted">{a.count} units</span>
                        </li>
                      ))}
                    </ul>
                    <div className="muted" style={{ margin: '6px 0 4px' }}>Sources</div>
                    {zone.sources.length === 0 && <div className="muted" style={{ paddingLeft: 8 }}>— none —</div>}
                    <ul className="dots">
                      {zone.sources.map((s) => (
                        <li key={s.title}>
                          <span className="badge">{s.kind}</span>
                          {s.title}
                          <span className="muted"> · {s.count} units</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="panel">
          <b>Summary</b>
          <ul className="dots" style={{ marginTop: 8 }}>
            <li>{stats.zones} zones</li>
            <li>{stats.units} active units</li>
            <li>{stats.agents.length} distinct agents</li>
          </ul>
          {stats.agents.length > 0 && (
            <>
              <div className="muted" style={{ margin: '8px 0 4px' }}>Top agents</div>
              {stats.agents.slice(0, 8).map(([agent, count]) => (
                <div key={agent} className="row" style={{ gap: 6 }}>
                  <span className="badge badge-agent">{agent}</span>
                  <span className="muted">{count}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
