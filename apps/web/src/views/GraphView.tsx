import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d';
import { api } from '../api';
import type { Graph, Scenario, Unit } from '../types';

const TYPE_COLORS: Record<string, string> = {
  fact: '#4f8cff', decision: '#a06bff', plan: '#3fb97f', procedure: '#e2a03f',
  preference: '#f26d9d', concept: '#37c8c8', lesson: '#e6784f', question: '#9aa2b1',
  default: '#9aa2b1',
};
const CATEGORY_COLORS: Record<string, string> = {
  code: '#4f8cff', infra: '#26c6da', workflow: '#e2a03f', product: '#a06bff',
  personal: '#f26d9d', research: '#37c8c8', meta: '#e6784f', other: '#9aa2b1',
  default: '#9aa2b1',
};
const REL_COLORS: Record<string, string> = {
  supports: '#3fb97f', contradicts: '#ef5350', part_of: '#4f8cff', extends: '#37c8c8',
  precedes: '#a06bff', references: '#e2a03f', related_to: '#9aa2b1', supersedes: '#f26d9d', caused_by: '#e6784f',
};
const CLUSTER_COLORS = [
  '#4f8cff', '#a06bff', '#3fb97f', '#e2a03f', '#37c8c8',
  '#f26d9d', '#e6784f', '#8d6e63', '#78909c', '#9ccc65',
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

interface GraphNodeData {
  id: string;
  name: string;
  fullTitle: string;
  val: number;
  type: string;
  form: string;
  status: string;
  category?: string;
  community?: string;
  communityLabel?: string;
  isScenario?: boolean;
  heat?: number;
}
interface GraphLinkData {
  source: string;
  target: string;
  relation: string;
}

function truncate(s: string, max = 14): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function heatColor(heat: number): string {
  if (heat >= 100) return '#ef4444';
  if (heat >= 50) return '#f59e0b';
  if (heat >= 10) return '#fb923c';
  if (heat >= 1) return '#fcd34d';
  return '#8b93a7';
}

export function GraphView({ onOpenUnit }: { onOpenUnit?: (id: string) => void }) {
  const graphRef = useRef<ForceGraphMethods<NodeObject<GraphNodeData>, LinkObject<GraphNodeData, GraphLinkData>> | undefined>(undefined);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Unit | Scenario | null>(null);

  const load = () => api.graph(true, true).then(setGraph).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { load(); }, []);

  const data = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };
    // Cluster-aware starting positions: place each community on its own arc so
    // the force simulation separates groups instead of collapsing into a blob.
    const clusterIndex = new Map((graph.clusters ?? []).map((c, i) => [c.id, i]));
    const groups = new Map<number, { angle: number; members: number }>();
    const groupOf = (n: { id: string; community?: string }): number =>
      n.community !== undefined && clusterIndex.has(n.community)
        ? clusterIndex.get(n.community)!
        : (graph.clusters?.length ?? 0) + Math.floor(hashStr(n.id) * 6);
    const initial = (n: { id: string; community?: string }) => {
      const g = groupOf(n);
      const existing = groups.get(g) ?? { angle: hashStr(`g${g}`) * Math.PI * 2, members: 0 };
      existing.members += 1;
      groups.set(g, existing);
      const groupCount = Math.max(1, (graph.clusters?.length ?? 0) + 6);
      const ring = 170 + g * 95;
      const memberRadius = 50 + hashStr(`${n.id}:${g}`) * 110;
      const memberAngle = hashStr(`${n.id}:${g}`) * Math.PI * 2;
      return {
        x: Math.cos(existing.angle) * ring + Math.cos(memberAngle) * memberRadius,
        y: Math.sin(existing.angle) * ring + Math.sin(memberAngle) * memberRadius,
        _g: g,
      };
    };
    return {
      nodes: graph.nodes.map((n) => {
        const pos = initial(n);
        return {
          id: n.id,
          name: truncate(n.title),
          fullTitle: n.title,
          val: n.isScenario ? Math.min(24, 9 + (n.heat || 0) * 0.6) : Math.min(12, (n.degree || 0) * 0.6 + 2.5),
          type: n.type,
          form: n.form,
          status: n.status,
          category: n.category,
          community: n.community,
          communityLabel: n.communityLabel,
          isScenario: n.isScenario,
          heat: n.heat,
          x: pos.x,
          y: pos.y,
        };
      }),
      links: graph.links.map((l) => ({ source: l.sourceUnitId, target: l.targetUnitId, relation: l.relation })),
    };
  }, [graph]);

  // Tune the d3 force engine once nodes are mounted: a stronger charge and
  // longer link distance spread clusters apart instead of collapsing them.
  useEffect(() => {
    const engine = graphRef.current;
    if (!engine) return;
    const charge = engine.d3Force('charge') as { strength?: (v: number) => unknown } | undefined;
    charge?.strength?.(-140);
    const link = engine.d3Force('link') as { distance?: (v: number) => unknown; iterations?: (v: number) => unknown } | undefined;
    link?.distance?.(52);
    link?.iterations?.(2);
  }, [data]);

  const clusterColor = useMemo(() => {
    const map = new Map<string, string>();
    (graph?.clusters ?? []).forEach((c, i) => {
      map.set(c.id, CLUSTER_COLORS[i % CLUSTER_COLORS.length] ?? CLUSTER_COLORS[0] ?? '#9aa2b1');
    });
    return map;
  }, [graph]);

  const linkStyle = (l: GraphLinkData) => {
    const major = l.relation !== 'related_to';
    const color = REL_COLORS[l.relation] ?? '#3a4050';
    return {
      color: major ? `${color}cc` : 'rgba(120,130,150,0.28)',
      width: major ? 1.6 : 0.6,
    };
  };

  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    const node = data.nodes.find((n) => n.id === selectedId);
    if (node?.isScenario) {
      api.scenario(selectedId).then(setSelected).catch(() => setSelected(null));
    } else {
      api.unit(selectedId).then(setSelected).catch(() => setSelected(null));
    }
  }, [selectedId, data.nodes]);

  return (
    <div className="grid">
      <div className="panel">
        <div className="row">
          <b>{graph?.nodes.length ?? 0} units</b>
          <span className="muted">· {graph?.links.length ?? 0} links</span>
          <span className="badge heat">🔥 {data.nodes.filter((n) => n.isScenario).length} scenes</span>
          {graph?.clusters?.length ? <span className="badge">{graph.clusters.length} clusters</span> : null}
          <button className="btn" onClick={load} style={{ marginLeft: 'auto' }}>Reload</button>
        </div>
        {error && <div className="muted">Error: {error}</div>}
        {data.nodes.some((n) => n.isScenario) && (
          <div className="muted" style={{ marginBottom: 8 }}>
            🔥 scene nodes are colored by recall heat (hot scenes first) — click a scene to inspect.
          </div>
        )}
        {data.nodes.length === 0 && (
          <div className="muted">
            Empty graph — only active (non-archived) units are shown. Ingest knowledge or restore archived units, then click Reload.
          </div>
        )}
        {data.nodes.length > 0 && data.nodes.length < 3 && (
          <div className="muted" style={{ marginBottom: 8 }}>
            Sparse graph ({data.nodes.length} active unit(s)). After Codex writes more memory, links appear via auto-curate.
          </div>
        )}
        {data.nodes.length > 0 && (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {Object.entries(CATEGORY_COLORS).filter(([k]) => k !== 'default').map(([k, color]) => (
                <span key={k} className="badge" style={{ color: '#fff', background: color }}>{k}</span>
              ))}
              <span className="muted" style={{ marginLeft: 'auto' }}>color = category (clusters / scenes override)</span>
            </div>
            <div style={{ position: 'relative', height: '70vh', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <ForceGraph2D
                ref={graphRef}
                graphData={data}
                backgroundColor="rgba(0,0,0,0)"
                nodeRelSize={4}
                cooldownTicks={220}
                cooldownTime={20000}
                d3AlphaDecay={0.015}
                d3VelocityDecay={0.32}
                nodeLabel={(n: GraphNodeData) =>
                  [
                    `${n.fullTitle}\n${n.isScenario ? `scenario · heat ${n.heat ?? 0}` : `${n.type} · ${n.form} · ${n.status}`}`,
                    n.category ? `\ncategory: ${n.category}` : '',
                    n.communityLabel ? `\ncluster: ${n.communityLabel}` : '',
                  ].join('')
                }
                nodeColor={(n: GraphNodeData) => {
                  if (n.isScenario) return heatColor(n.heat ?? 0);
                  if (n.community) {
                    const c = clusterColor.get(n.community);
                    if (c) return c;
                  }
                  if (n.category && CATEGORY_COLORS[n.category]) return CATEGORY_COLORS[n.category]!;
                  return TYPE_COLORS[n.type] ?? '#9aa2b1';
                }}
                linkColor={(l: GraphLinkData) => linkStyle(l).color}
                linkWidth={(l: GraphLinkData) => linkStyle(l).width}
                onNodeClick={(n: GraphNodeData) => {
                  const id = String(n.id);
                  setSelectedId(id);
                  if (!n.isScenario) onOpenUnit?.(id);
                }}
                onEngineStop={() => graphRef.current?.zoomToFit(450, 70)}
              />
            </div>
          </>
        )}
      </div>
      {selected && 'body' in selected && (
        <div className="panel">
          <div className="row">
            <h3 style={{ margin: 0 }}>{selected.title}</h3>
            <span className="badge">{selected.type}</span>
            <span className="badge">{selected.form}</span>
            <span className="badge">v{selected.version}</span>
          </div>
          <p className="muted">{selected.summary}</p>
          {selected.tags.map((t) => <span key={t} className="tag">{t}</span>)}
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 10, borderRadius: 8 }}>{selected.body}</pre>
          <div className="muted">Sources: {selected.sourceCount} · importance {selected.importance.toFixed(2)} · decay {selected.decay.toFixed(2)} · confidence {(selected.confidence * 100).toFixed(0)}%</div>
        </div>
      )}
      {selected && !('body' in selected) && (
        <div className="panel">
          <div className="row">
            <h3 style={{ margin: 0 }}>{selected.title}</h3>
            <span className="badge">scenario</span>
            <span className="badge heat">🔥 {selected.heat ?? 0}</span>
            <span className="badge">v{selected.version}</span>
          </div>
          <p className="muted">{selected.summary}</p>
          {selected.tags.map((t) => <span key={t} className="tag">{t}</span>)}
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel2)', padding: 10, borderRadius: 8 }}>{selected.content}</pre>
          <div className="muted">
            Source units: {selected.sourceUnitIds.length} · last hit {selected.lastHitAt ? new Date(selected.lastHitAt).toLocaleString() : 'never'}
          </div>
        </div>
      )}
    </div>
  );
}
