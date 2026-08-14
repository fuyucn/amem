import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d';
import { api } from '../api';
import { PageHead } from '../components/PageHead';
import type { Graph, Scenario, Unit, Zone } from '../types';

// Single-hue family: emerald/teal for signal, cool slate for neutrals.
const TYPE_COLORS: Record<string, string> = {
  decision: '#34d399', lesson: '#34d399', plan: '#4ade80', procedure: '#2dd4bf',
  fact: '#6ee7b7', concept: '#5eead4', question: '#8b93a3', preference: '#8b93a3',
  default: '#7c8ba1',
};
const CATEGORY_COLORS: Record<string, string> = {
  code: '#34d399', infra: '#2dd4bf', workflow: '#6ee7b7', product: '#4ade80',
  personal: '#5eead4', research: '#86efac', meta: '#67e8f9', other: '#94a3b8',
  default: '#7c8ba1',
};
const REL_COLORS: Record<string, string> = {
  supports: '#34d399', part_of: '#2dd4bf', extends: '#6ee7b7', precedes: '#4ade80',
  references: '#94a3b8', related_to: '#3a4050', supersedes: '#5eead4', caused_by: '#86efac',
  contradicts: '#f87171',
};
const CLUSTER_TINTS = [
  '#34d399', '#2dd4bf', '#6ee7b7', '#4ade80', '#5eead4',
  '#86efac', '#67e8f9', '#8fa8a4', '#94a3b8', '#a8b5c4',
];
const ZONE_TINTS = [
  '#34d399', '#2dd4bf', '#4ade80', '#5eead4', '#86efac', '#67e8f9',
  '#60a5fa', '#818cf8', '#a78bfa', '#f472b6', '#fb923c', '#facc15',
  '#22d3ee', '#a3e635', '#94a3b8',
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
  degree: number;
  type: string;
  form: string;
  status: string;
  category?: string;
  zoneId?: string;
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
  if (heat >= 100) return '#a7f3d0';
  if (heat >= 50) return '#34d399';
  if (heat >= 10) return '#2dd4bf';
  if (heat >= 1) return '#7c9a8e';
  return '#5b6472';
}

type DrawNode = GraphNodeData & { x: number; y: number };

const SCENES_GROUP = '__scenes__';
const NO_ZONE_GROUP = '__no_zone__';

function groupKeyOf(n: { isScenario?: boolean; zoneId?: string; community?: string }, mode: 'zone' | 'cluster'): string {
  if (mode === 'zone') {
    if (n.isScenario) return SCENES_GROUP;
    return n.zoneId ?? NO_ZONE_GROUP;
  }
  return n.community ?? NO_ZONE_GROUP;
}

// Zoom-level label policy. Far out only cluster anchors are named; zooming in
// first reveals important nodes (scenarios, hubs, hot memories), then everything.
const ZOOM_ALL = 1.15;
const ZOOM_IMPORTANT = 0.55;

function nodeRadius(n: GraphNodeData): number {
  if (n.isScenario) return Math.min(9, 4 + (n.heat ?? 0) * 0.09);
  return Math.min(6, 2 + Math.sqrt(n.degree ?? 0) * 0.9);
}

function isImportant(n: GraphNodeData): boolean {
  return Boolean(n.isScenario) || (n.degree ?? 0) >= 4 || (n.heat ?? 0) >= 1;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

export function GraphView({ onOpenUnit }: { onOpenUnit?: (id: string) => void }) {
  const graphRef = useRef<ForceGraphMethods<NodeObject<GraphNodeData>, LinkObject<GraphNodeData, GraphLinkData>> | undefined>(undefined);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Unit | Scenario | null>(null);
  const [zoomHint, setZoomHint] = useState(true);
  const [zoomK, setZoomK] = useState<number | null>(null);
  const [groupMode, setGroupMode] = useState<'zone' | 'cluster'>('zone');
  const [activeZone, setActiveZone] = useState<string | null>(null);

  const labelTier = (k: number): { name: string; count: number } => {
    const anchors = data.nodes.filter((n) => anchorIds.has(n.id));
    if (k < ZOOM_IMPORTANT) return { name: '簇锚点', count: anchors.length };
    if (k < ZOOM_ALL) {
      const count = data.nodes.filter((n) => anchorIds.has(n.id) || isImportant(n)).length;
      return { name: '热点/场景/枢纽', count };
    }
    return { name: '全部标题', count: data.nodes.length };
  };

  const load = () => {
    setError('');
    return Promise.all([
      api.graph(true, true).then(setGraph).catch((e) => setError(String(e.message ?? e))),
      api.zones().then(setZones).catch(() => setZones([])),
    ]);
  };
  useEffect(() => { load(); }, []);

  const data = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };
    // Partition-aware starting positions: place each zone (or community) on
    // its own arc so the force simulation separates groups instead of
    // collapsing into a blob. Zone mode is the default — users asked for
    // visible partitions, not one undifferentiated cloud.
    const groupKeys = [...new Set(graph.nodes.map((n) => groupKeyOf(n, groupMode)))].sort();
    const groupIndex = new Map(groupKeys.map((k, i) => [k, i]));
    const groups = new Map<number, { angle: number; members: number }>();
    const initial = (n: { id: string; isScenario?: boolean; zoneId?: string; community?: string }) => {
      const g = groupIndex.get(groupKeyOf(n, groupMode)) ?? 0;
      const existing = groups.get(g) ?? { angle: hashStr(`g${g}`) * Math.PI * 2, members: 0 };
      existing.members += 1;
      groups.set(g, existing);
      const ring = 170 + g * 110;
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
          degree: n.degree || 0,
          type: n.type,
          form: n.form,
          status: n.status,
          category: n.category,
          zoneId: n.zoneId,
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
  }, [graph, groupMode]);

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
      map.set(c.id, CLUSTER_TINTS[i % CLUSTER_TINTS.length] ?? CLUSTER_TINTS[0] ?? '#7c8ba1');
    });
    return map;
  }, [graph]);

  // Stable per-zone palette: order follows the API's zone list so the legend,
  // node fills, and filter chips always agree; unknown ids fall back to a hash.
  const zoneColor = useMemo(() => {
    const map = new Map<string, string>();
    const used = new Set(data.nodes.filter((n) => !n.isScenario && n.zoneId).map((n) => n.zoneId!));
    const ordered = zones.filter((z) => used.has(z.id));
    ordered.forEach((z, i) => map.set(z.id, ZONE_TINTS[i % ZONE_TINTS.length] ?? '#94a3b8'));
    for (const id of used) {
      if (!map.has(id)) map.set(id, ZONE_TINTS[(hashStr(id) * ZONE_TINTS.length) | 0] ?? '#94a3b8');
    }
    return map;
  }, [zones, data.nodes]);

  const zoneName = (zoneId?: string): string => {
    if (!zoneId) return '未分区';
    if (zoneId === SCENES_GROUP) return 'Scenes';
    return zones.find((z) => z.id === zoneId)?.name ?? zoneId.replace(/^z_/, '');
  };

  // Click a zone chip to isolate it; only intra-zone links survive so the
  // partition reads as a clean subgraph instead of a cross-linked tangle.
  const visible = useMemo(() => {
    if (!activeZone) return data;
    const ids = new Set(
      data.nodes
        .filter((n) => groupKeyOf(n, groupMode) === activeZone)
        .map((n) => n.id),
    );
    return {
      nodes: data.nodes.filter((n) => ids.has(n.id)),
      links: data.links.filter((l) => ids.has(String(l.source)) && ids.has(String(l.target))),
    };
  }, [data, activeZone, groupMode]);

  const linkStyle = (l: GraphLinkData) => {
    const major = l.relation !== 'related_to';
    const color = REL_COLORS[l.relation] ?? '#3a4050';
    return {
      color: major ? `${color}cc` : 'rgba(120,130,150,0.28)',
      width: major ? 1.6 : 0.6,
    };
  };

  // One anchor node per partition (highest degree + heat), capped so far-out
  // zoom stays readable even with dozens of zones/clusters.
  const anchorIds = useMemo(() => {
    const byGroup = new Map<string, GraphNodeData[]>();
    for (const n of data.nodes) {
      const key = groupMode === 'zone' ? groupKeyOf(n, 'zone') : (n.communityLabel ?? '');
      if (!key) continue;
      const arr = byGroup.get(key) ?? [];
      arr.push(n);
      byGroup.set(key, arr);
    }
    const picked: GraphNodeData[] = [];
    for (const arr of byGroup.values()) {
      let best: GraphNodeData | null = null;
      let bestScore = -1;
      for (const n of arr) {
        const score = (n.degree ?? 0) * 2 + (n.heat ?? 0);
        if (score > bestScore) {
          bestScore = score;
          best = n;
        }
      }
      if (best) picked.push(best);
    }
    picked.sort((a, b) => ((b.degree ?? 0) + (b.heat ?? 0)) - ((a.degree ?? 0) + (a.heat ?? 0)));
    return new Set(picked.slice(0, 14).map((n) => n.id));
  }, [data.nodes, groupMode]);

  const nodeFill = (n: GraphNodeData): string => {
    if (n.isScenario) return heatColor(n.heat ?? 0);
    if (groupMode === 'zone') {
      return zoneColor.get(n.zoneId ?? NO_ZONE_GROUP) ?? '#94a3b8';
    }
    if (n.community) {
      const c = clusterColor.get(n.community);
      if (c) return c;
    }
    if (n.category && CATEGORY_COLORS[n.category]) return CATEGORY_COLORS[n.category]!;
    return TYPE_COLORS[n.type] ?? '#9aa2b1';
  };

  const drawNode = (n: DrawNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    // force-graph passes the true d3 zoom k as globalScale. Do NOT read
    // ctx.getTransform().a: the canvas transform is set to devicePixelRatio
    // * k, so on Retina displays it is 2x (or 3x) the actual zoom and would
    // shift every label tier threshold.
    const zoom = globalScale || ctx.getTransform().a || 1;
    const isAnchor = anchorIds.has(n.id);
    const r = nodeRadius(n) * (isAnchor && zoom < ZOOM_IMPORTANT ? 1.25 : 1);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = nodeFill(n);
    ctx.fill();
    if (n.isScenario) {
      ctx.lineWidth = 1 / globalScale;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
    }

    const showLabel =
      zoom >= ZOOM_ALL ||
      (zoom >= ZOOM_IMPORTANT && (isAnchor || isImportant(n))) ||
      (zoom < ZOOM_IMPORTANT && isAnchor);
    if (!showLabel) return;

    const label = zoom < ZOOM_IMPORTANT && isAnchor
      ? truncate(groupMode === 'zone' ? zoneName(n.zoneId) : (n.communityLabel ?? n.name), 24)
      : n.name;
    const fontSize = (zoom < ZOOM_IMPORTANT && isAnchor ? 11.5 : 10) / globalScale;
    const pad = 4 / globalScale;
    ctx.font = `${zoom < ZOOM_IMPORTANT && isAnchor ? 700 : 500} ${fontSize}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const w = ctx.measureText(label).width;
    const y = n.y + r + 3 / globalScale;
    roundedRect(ctx, n.x - w / 2 - pad, y - pad * 0.4, w + pad * 2, fontSize * 1.35, 3 / globalScale);
    ctx.fillStyle = 'rgba(8,12,20,0.72)';
    ctx.fill();
    ctx.fillStyle = zoom < ZOOM_IMPORTANT && isAnchor ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.9)';
    ctx.fillText(label, n.x, y);
  };

  const drawPointerArea = (n: DrawNode, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    ctx.arc(n.x, n.y, nodeRadius(n) + 3, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
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
      <PageHead
        title="Knowledge graph"
        sub="Default view partitions memory by zone — each workspace partition sits on its own arc. Switch to cluster mode for auto-detected communities. Click a zone chip to isolate it."
      >
        <span className="legend-chip">
          <i style={{ background: '#34d399' }} />
          {data.nodes.filter((n) => n.isScenario).length} hot scenes
        </span>
        {groupMode === 'cluster' && graph?.clusters?.length ? <span className="legend-chip">{graph.clusters.length} clusters</span> : null}
        {groupMode === 'zone' && <span className="legend-chip">{new Set(data.nodes.filter((n) => !n.isScenario && n.zoneId).map((n) => n.zoneId)).size} zones</span>}
        {zoomK !== null && data.nodes.length > 0 && (
          <span className="legend-chip">
            zoom {zoomK.toFixed(2)} · {labelTier(zoomK).name} · {labelTier(zoomK).count}/{data.nodes.length} labels
          </span>
        )}
        <button className="btn" onClick={() => { setActiveZone(null); load(); }}>Reload</button>
      </PageHead>
      <div className="panel">
        {error && <div className="muted">Error: {error}</div>}
        {data.nodes.some((n) => n.isScenario) && (
          <p className="muted" style={{ margin: '0 0 10px', fontSize: 12.5 }}>
            Scene nodes are tinted by recall heat — brighter means more recently hit. Click a scene to inspect it.
          </p>
        )}
        {data.nodes.length === 0 && (
          <div className="empty-note">
            Empty graph. Only active (non-archived) units are shown — ingest knowledge or restore archived units, then reload.
          </div>
        )}
        {data.nodes.length > 0 && data.nodes.length < 3 && (
          <div className="empty-note" style={{ marginBottom: 10 }}>
            Sparse graph ({data.nodes.length} active unit(s)). Links appear as Codex writes memory and auto-curate runs.
          </div>
        )}
        {data.nodes.length > 0 && (
          <>
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <button
                className={groupMode === 'zone' ? 'btn primary' : 'btn'}
                onClick={() => { setGroupMode('zone'); setActiveZone(null); }}
              >
                By zone
              </button>
              <button
                className={groupMode === 'cluster' ? 'btn primary' : 'btn'}
                onClick={() => { setGroupMode('cluster'); setActiveZone(null); }}
              >
                By cluster
              </button>
              {groupMode === 'zone' && (
                <div className="zone-chips" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, marginLeft: 10 }}>
                  {zones
                    .filter((z) => data.nodes.some((n) => n.zoneId === z.id))
                    .map((z) => (
                      <button
                        key={z.id}
                        className={activeZone === z.id ? 'legend-chip chip-active' : 'legend-chip'}
                        style={{ cursor: 'pointer', border: 'none', background: activeZone === z.id ? 'var(--panel2)' : 'transparent' }}
                        onClick={() => setActiveZone((prev) => (prev === z.id ? null : z.id))}
                        title={`${z.description ?? z.slug} — click to isolate`}
                      >
                        <i style={{ background: zoneColor.get(z.id) }} />
                        {z.name}
                        <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>
                          {data.nodes.filter((n) => n.zoneId === z.id).length}
                        </span>
                      </button>
                    ))}
                  {activeZone && (
                    <button className="btn" style={{ padding: '2px 8px' }} onClick={() => setActiveZone(null)}>
                      Clear
                    </button>
                  )}
                </div>
              )}
              {groupMode === 'cluster' &&
                Object.entries(CATEGORY_COLORS).filter(([k]) => k !== 'default').map(([k, color]) => (
                  <span key={k} className="legend-chip"><i style={{ background: color }} />{k}</span>
                ))}
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
                {groupMode === 'zone' ? 'zone partitions · scenes override' : 'category · clusters / scenes override'}
              </span>
            </div>
            {zoomHint && (
              <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
                Scroll to zoom: far out shows cluster anchors · mid shows hot scenes and hubs · close in shows every title
                <button className="btn" onClick={() => setZoomHint(false)} style={{ marginLeft: 8, padding: '2px 8px' }}>Hide</button>
              </div>
            )}
            <div style={{ position: 'relative', height: '70vh', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <ForceGraph2D
                ref={graphRef}
                graphData={visible}
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
                    n.zoneId ? `\nzone: ${zoneName(n.zoneId)}` : '',
                    n.communityLabel ? `\ncluster: ${n.communityLabel}` : '',
                  ].join('')
                }
                nodeColor={(n: GraphNodeData) => nodeFill(n)}
                nodeCanvasObject={(n, ctx, globalScale) => drawNode(n as DrawNode, ctx, globalScale)}
                nodePointerAreaPaint={(n, color, ctx) => drawPointerArea(n as DrawNode, color, ctx)}
                linkColor={(l: GraphLinkData) => linkStyle(l).color}
                linkWidth={(l: GraphLinkData) => linkStyle(l).width}
                onNodeClick={(n: GraphNodeData) => {
                  const id = String(n.id);
                  setSelectedId(id);
                  if (!n.isScenario) onOpenUnit?.(id);
                }}
                onZoom={({ k }: { k: number }) => setZoomK(k)}
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
            <span className="badge">{selected.heat ?? 0} heat</span>
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
