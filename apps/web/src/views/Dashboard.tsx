import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle,
  Database,
  GearSix,
  Heartbeat,
  Lightbulb,
  Lightning,
  Pulse as PulseIcon,
  Stack,
  TrendUp,
  WarningCircle,
} from '@phosphor-icons/react';
import { api } from '../api';
import { PageHead } from '../components/PageHead';
import type { ActivityEvent, ActivitySummary, Stats } from '../types';
import { unitPath } from '../router';
import { accessRows, flowCards } from '../flow';

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const fmt = (n: number) => n.toLocaleString();

function healthScore(stats: Stats, summary: ActivitySummary | null): number {
  const c = stats.counts;
  if (c.units === 0) return 0;
  const reviewed = Math.max(0, c.unitsActive - c.pendingReview);
  const review = c.unitsActive > 0 ? reviewed / c.unitsActive : 0;
  const cats = Object.keys(stats.byCategory).length;
  const target = Math.min(12, Math.max(3, Math.ceil(c.unitsActive / 8)));
  const coverage = cats / target;
  const freshness = Math.min(1, (summary?.window.events ?? 0) / 10);
  const dedup = stats.tokensSavedByDedup + stats.tokenWasteAvoided;
  const total = dedup + stats.recallTokensDelivered;
  const efficiency = total > 0 ? Math.min(1, dedup / total) : 0.4;
  const score = review * 0.35 + Math.min(1, coverage) * 0.25 + freshness * 0.25 + efficiency * 0.15;
  return Math.round(score * 100);
}

interface Insight {
  key: string;
  tone: 'ok' | 'info' | 'warn';
  title: string;
  desc: string;
  href: string;
}

function buildInsights(stats: Stats, summary: ActivitySummary | null): Insight[] {
  const c = stats.counts;
  const out: Insight[] = [];
  if (c.pendingReview > 0) {
    out.push({
      key: 'review',
      tone: 'warn',
      title: `${c.pendingReview} unit${c.pendingReview === 1 ? '' : 's'} awaiting review`,
      desc: 'Agents only recall validated knowledge. Accept or discard pending memories to keep the graph clean.',
      href: '/review',
    });
  }
  const events = summary?.window.events ?? 0;
  if (c.units > 0 && events === 0) {
    out.push({
      key: 'quiet',
      tone: 'info',
      title: 'No activity in the last 24h',
      desc: 'No agent wrote or read memory. Wire the MCP server into Codex or Claude Code so recall starts paying off.',
      href: '/settings',
    });
  }
  const cats = Object.keys(stats.byCategory).length;
  if (c.unitsActive > 4 && cats < 3) {
    out.push({
      key: 'organize',
      tone: 'info',
      title: `Only ${cats} categor${cats === 1 ? 'y' : 'ies'} so far`,
      desc: 'Run classify to auto-tag units by project or domain. Categorized memory is faster to recall and easier to navigate.',
      href: '/units',
    });
  }
  if (c.units > 10 && c.crystals === 0) {
    out.push({
      key: 'consolidate',
      tone: 'info',
      title: 'Ready to consolidate',
      desc: 'Curate promotes recurring knowledge into crystals so recall surfaces stable facts instead of raw history.',
      href: '/settings',
    });
  }
  if (stats.tokensSavedByDedup + stats.tokenWasteAvoided > 0) {
    out.push({
      key: 'dedup',
      tone: 'ok',
      title: `${fmt(stats.tokensSavedByDedup + stats.tokenWasteAvoided)} tokens not wasted`,
      desc: 'Dedup skipped re-adding known knowledge and distillation avoided noisy units, keeping context lean.',
      href: '/activity',
    });
  }
  if (out.length === 0 && c.units > 0) {
    out.push({
      key: 'all-good',
      tone: 'ok',
      title: 'Memory is in good shape',
      desc: 'Everything is reviewed, categorized and being used. Keep writing small atomic units as you work.',
      href: '/dashboard',
    });
  }
  return out.slice(0, 4);
}

function toneMeta(tone: Insight['tone']) {
  if (tone === 'warn') return { icon: WarningCircle, cls: 'warn' };
  if (tone === 'ok') return { icon: CheckCircle, cls: 'ok' };
  return { icon: Lightbulb, cls: 'info' };
}

function kindTone(kind: string): 'write' | 'use' | 'sys' {
  if (['recall', 'search', 'export', 'working_memory'].includes(kind)) return 'use';
  if (kind.startsWith('auth_') || kind.startsWith('workspace_') || kind === 'review') return 'sys';
  return 'write';
}

function HealthRing({ score, tone }: { score: number; tone: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  return (
    <svg viewBox="0 0 88 88" className={`health-ring ${tone}`} role="img" aria-label={`Memory health ${score}%`}>
      <circle cx="44" cy="44" r={r} className="ring-bg" />
      <g transform="rotate(-90 44 44)">
        <circle cx="44" cy="44" r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={off} />
      </g>
      <text x="44" y="42" className="ring-num" textAnchor="middle">{score}</text>
      <text x="44" y="57" className="ring-lbl" textAnchor="middle">health</text>
    </svg>
  );
}

function Skel() {
  return (
    <div className="dash" aria-busy="true" aria-label="Loading dashboard">
      <div className="skel-hero">
        <div className="skel skel-ring" />
        <div className="skel skel-lines" />
      </div>
      <div className="dash-cols">
        <div className="skel skel-panel" />
        <div className="skel skel-panel" />
      </div>
      <div className="dash-grid">
        <div className="skel skel-panel" />
        <div className="skel skel-panel" />
        <div className="skel skel-panel" />
        <div className="skel skel-panel" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="dash-empty">
      <div className="dash-empty-icon"><Database size={30} weight="duotone" /></div>
      <h2>Your memory is empty</h2>
      <p className="muted">
        Amem turns conversations, docs and code into an organized knowledge graph agents can recall.
        Start by importing material or let Codex write as it works.
      </p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <a className="btn primary" href="/traces"><Database size={15} weight="bold" /> Import material</a>
        <a className="btn" href="/settings"><GearSix size={15} /> Configure MCP</a>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all([api.stats(), api.activity({ limit: 10 }), api.activitySummary({ hours: 24 }).catch(() => null)])
        .then(([s, a, sm]) => {
          if (!alive) return;
          setStats(s);
          setEvents(a);
          setSummary(sm);
          setError('');
        })
        .catch((e) => alive && setError(String((e as Error).message ?? e)));
    };
    load();
    const id = window.setInterval(load, 8000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [tick]);

  const score = useMemo(() => (stats ? healthScore(stats, summary) : 0), [stats, summary]);
  const insights = useMemo(() => (stats ? buildInsights(stats, summary) : []), [stats, summary]);

  if (error && !stats) {
    return (
      <div className="panel err-panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>Failed to load dashboard</b>
          <button className="btn" onClick={() => setTick((t) => t + 1)}>Retry</button>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>{error}</div>
      </div>
    );
  }
  if (!stats) return <Skel />;
  const c = stats.counts;
  const flow = summary ? flowCards(summary) : null;
  const accessed = accessRows(summary, 5);
  const maxUnits = Math.max(1, ...stats.perDay.map((d) => d.units));
  const maxTraces = Math.max(1, ...stats.perDay.map((d) => d.traces));
  const typeTotal = Object.values(stats.byType).reduce((a, b) => a + b, 0) || 1;
  const catTotal = Object.values(stats.byCategory).reduce((a, b) => a + b, 0) || 1;
  const tone = score >= 75 ? 'ok' : score >= 45 ? 'warn' : 'bad';
  const hasData = c.units > 0 || c.traces > 0 || c.sources > 0;

  const stages: Array<{ name: string; count: number; desc: string; live?: string; sink?: boolean }> = [
    { name: 'Sources', count: c.sources, desc: 'Docs · code · sessions' },
    { name: 'Traces', count: c.traces, desc: 'Raw ingested material', live: summary && summary.window.events > 0 ? 'active' : undefined },
    { name: 'Units', count: c.units, desc: 'Atomic distilled memories', live: summary && summary.input.unitsCreated > 0 ? `+${summary.input.unitsCreated} today` : undefined },
    { name: 'Crystals', count: c.crystals, desc: 'Consolidated core knowledge' },
    {
      name: 'Recall',
      count: stats.recallTokensDelivered,
      desc: 'Tokens delivered to agents',
      live: summary && summary.output.tokensDelivered > 0 ? `${fmt(summary.output.tokensDelivered)} tok / 24h` : undefined,
      sink: true,
    },
  ];

  if (!hasData) return <EmptyState />;

  return (
    <div className="dash">
      <PageHead
        title="Overview"
        sub="How memory is growing, being used and staying lean — updated live from the activity feed."
      >
        <span className="live-pill" title="Polls the activity feed every 8s">
          <span className="live-dot" />
          LIVE
        </span>
        <a className="btn" href="/activity">Open activity</a>
      </PageHead>
      <section className="dash-hero">
        <div className="hero-health">
          <HealthRing score={score} tone={tone} />
          <div className="hero-copy">
            <div className="hero-eyebrow">Memory intelligence</div>
            <h2 className="hero-title">
              {score >= 75 ? 'Healthy and self-organizing' : score >= 45 ? 'Needs a little attention' : 'Getting started'}
            </h2>
            <p className="muted hero-sub">
              {c.unitsActive} active units · {Object.keys(stats.byCategory).length} categories ·{' '}
              {fmt(stats.tokensSavedByDedup + stats.tokenWasteAvoided)} tokens saved
            </p>
          </div>
        </div>
        <div className="hero-stats">
          {[
            [c.units, 'Units'],
            [c.crystals, 'Crystals'],
            [c.links, 'Links'],
            [c.sources, 'Sources'],
          ].map(([n, l]) => (
            <div className="stat-chip" key={l as string}>
              <div className="stat-chip-num">{fmt(n as number)}</div>
              <div className="stat-chip-lbl">{l}</div>
            </div>
          ))}
        </div>
      </section>

      {insights.length > 0 && (
        <section className="suggest-row">
          {insights.map((ins) => {
            const t = toneMeta(ins.tone);
            const Icon = t.icon;
            return (
              <a className={`suggest-card ${t.cls}`} href={ins.href} key={ins.key}>
                <span className="suggest-icon"><Icon size={17} weight="bold" /></span>
                <span className="suggest-body">
                  <b>{ins.title}</b>
                  <span className="muted">{ins.desc}</span>
                </span>
                <ArrowRight className="suggest-arrow" size={14} />
              </a>
            );
          })}
        </section>
      )}

      <section className="panel pipeline">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Knowledge pipeline</h3>
          <span className="muted">how raw material becomes recallable memory</span>
        </div>
        <div className="flow">
          {stages.map((s, i) => (
            <span key={s.name} style={{ display: 'contents' }}>
              {i > 0 && <ArrowRight className="flow-arrow" size={16} />}
              <div className={s.sink ? 'flow-stage flow-sink' : 'flow-stage'}>
                <div className="flow-count">{fmt(s.count)}</div>
                <div className="flow-name">{s.name}</div>
                <div className="flow-desc">{s.desc}</div>
                {s.live && <span className="flow-live"><span className="live-dot" />{s.live}</span>}
              </div>
            </span>
          ))}
        </div>
      </section>

      {flow && (
        <section className="dash-cols">
          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>Agent memory access</h3>
              <span className="muted">last {summary?.window.hours}h</span>
            </div>
            <div className="flow-cards">
              {flow.map((f) => (
                <div className="flow-card" key={f.id}>
                  <div className="flow-card-num">{f.value.toLocaleString()}</div>
                  <div className="flow-card-lbl">{f.label}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{f.detail}</div>
                </div>
              ))}
            </div>
            <h4 className="subhead">Units hit by recall / search</h4>
            {accessed.length === 0 ? (
              <div className="muted">No recalls yet. Codex calls `recall` at session start once MCP is wired.</div>
            ) : (
              <ul className="dots">
                {accessed.map((u) => (
                  <li key={u.unitId}>
                    <a className="unit-link" href={unitPath(u.unitId)}>
                      <span className="badge">{u.type}</span> <b>{u.title}</b>
                      <span className="muted"> · {u.accessCount}x</span>
                      {u.actors.length > 0 && <span className="muted"> · via {u.actors.join(', ')}</span>}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>Recent activity</h3>
              <a className="muted" href="/activity" style={{ fontSize: 12 }}>view all <ArrowRight size={12} style={{ verticalAlign: -1 }} /></a>
            </div>
            {events.length === 0 ? (
              <div className="muted">No activity yet. Open the Activity tab after Codex writes or recalls memory.</div>
            ) : (
              <ul className="event-list">
                {events.map((ev) => {
                  const tone2 = kindTone(ev.kind);
                  return (
                    <li key={ev.id} className="event-card">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span className={`badge kind-${ev.kind}`}>{ev.kind}</span>
                        <span className={`kind-tone ${tone2}`} />
                        <span className="muted" title={ev.createdAt}>{relTime(ev.createdAt)}</span>
                      </div>
                      <div className="event-summary">{ev.summary}</div>
                      {ev.actor && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>via {ev.actor}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      )}

      <section className="dash-grid">
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ marginTop: 0 }}>By type</h3>
            <TrendUp size={15} className="muted" />
          </div>
          {Object.entries(stats.byType)
            .sort(([, a], [, b]) => b - a)
            .map(([t, n]) => (
              <div className="dist-row" key={t}>
                <span className="dist-label">{t}</span>
                <div className="dist-bar"><i style={{ width: `${(n / typeTotal) * 100}%` }} /></div>
                <span className="dist-num">{n}</span>
                <span className="dist-pct">{Math.round((n / typeTotal) * 100)}%</span>
              </div>
            ))}
        </div>

        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ marginTop: 0 }}>By category</h3>
            <Stack size={15} className="muted" />
          </div>
          {Object.entries(stats.byCategory)
            .sort(([, a], [, b]) => b - a)
            .map(([cat, n]) => (
              <div className="dist-row" key={cat}>
                <span className="dist-label">{cat}</span>
                <div className="dist-bar"><i style={{ width: `${(n / catTotal) * 100}%` }} /></div>
                <span className="dist-num">{n}</span>
                <span className="dist-pct">{Math.round((n / catTotal) * 100)}%</span>
              </div>
            ))}
        </div>

        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ marginTop: 0 }}>Growth</h3>
            <PulseIcon size={15} className="muted" />
          </div>
          {stats.perDay.length === 0 ? (
            <div className="muted">No data yet.</div>
          ) : (
            <div className="grow-chart">
              {stats.perDay.slice(-10).map((d) => (
                <div className="grow-col" key={d.day} title={`${d.day}: ${d.units} units · ${d.traces} traces`}>
                  <div className="grow-bars">
                    <i className="grow-units" style={{ height: `${Math.max(4, (d.units / maxUnits) * 100)}%` }} />
                    <i className="grow-traces" style={{ height: `${Math.max(4, (d.traces / maxTraces) * 100)}%` }} />
                  </div>
                  <span className="grow-day">{d.day.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="legend">
            <span><i className="lg-units" /> units</span>
            <span><i className="lg-traces" /> traces</span>
          </div>
        </div>

        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ marginTop: 0 }}>Token economics</h3>
            <Lightning size={15} className="muted" />
          </div>
          <div className="eco-row">
            <span className="muted">Dedup saved</span>
            <b className="num">{fmt(stats.tokensSavedByDedup)}</b>
          </div>
          <div className="eco-row">
            <span className="muted">Waste avoided</span>
            <b className="num">{fmt(stats.tokenWasteAvoided)}</b>
          </div>
          <div className="eco-row">
            <span className="muted">Recall delivered</span>
            <b className="num">{fmt(stats.recallTokensDelivered)}</b>
          </div>
          <div className="eco-net">
            <span className="muted">Net context saved</span>
            <b className="num eco-net-num">{fmt(stats.tokensSavedByDedup + stats.tokenWasteAvoided - stats.recallTokensDelivered)}</b>
          </div>
          <p className="muted" style={{ marginBottom: 0, marginTop: 10, fontSize: 12 }}>
            Dedup skips re-adding known knowledge; recall delivers only relevant context instead of raw history.
          </p>
        </div>
      </section>

      <footer className="dash-foot muted">
        <Heartbeat size={13} weight="fill" /> Amem memory dashboard · auto-refreshes every 8s
      </footer>
    </div>
  );
}
