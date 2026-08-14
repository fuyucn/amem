import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { GlobalSearch } from './components/GlobalSearch';
import { Activity } from './views/Activity';
import { Dashboard } from './views/Dashboard';
import { GraphView } from './views/GraphView';
import { Search } from './views/Search';
import { Units } from './views/Units';
import { Traces } from './views/Traces';
import { Scenarios } from './views/Scenarios';
import { Assets } from './views/Assets';
import { PersonaView } from './views/Persona';
import { WorkingMemory } from './views/WorkingMemory';
import { Review } from './views/Review';
import { Settings } from './views/Settings';
import { Zones } from './views/Zones';
import { Login } from './views/Login';
import { canonicalPath, DEFAULT_TAB, parsePath, tabPath, unitPath, type Route, type Tab } from './router';
import type { Zone } from './types';

const TABS: Array<{ id: Tab; label: string; path: string }> = [
  { id: 'dashboard', label: 'Overview', path: '/dashboard' },
  { id: 'activity', label: 'Activity', path: '/activity' },
  { id: 'zones', label: 'Zones', path: '/zones' },
  { id: 'graph', label: 'Graph', path: '/graph' },
  { id: 'search', label: 'Search', path: '/search' },
  { id: 'units', label: 'Units', path: '/units' },
  { id: 'traces', label: 'Ingest', path: '/traces' },
  { id: 'scenarios', label: 'Scenarios', path: '/scenarios' },
  { id: 'assets', label: 'Assets', path: '/assets' },
  { id: 'persona', label: 'Persona', path: '/persona' },
  { id: 'working-memory', label: 'Working Memory', path: '/working-memory' },
  { id: 'review', label: 'Review', path: '/review' },
  { id: 'settings', label: 'Settings', path: '/settings' },
];

const NAV_SECTIONS: Array<{ label: string; tabs: Array<{ id: Tab; label: string; hint: string }> }> = [
  {
    label: 'Overview',
    tabs: [
      { id: 'dashboard', label: 'Overview', hint: 'Stats · data flow' },
      { id: 'activity', label: 'Activity', hint: 'Live feed' },
      { id: 'zones', label: 'Zones', hint: 'Partitions · access' },
    ],
  },
  {
    label: 'Knowledge',
    tabs: [
      { id: 'graph', label: 'Graph', hint: 'Knowledge graph' },
      { id: 'search', label: 'Search', hint: 'Keyword + recall' },
      { id: 'units', label: 'Units', hint: 'Atomic memories' },
      { id: 'working-memory', label: 'Working Memory', hint: 'Session context' },
      { id: 'review', label: 'Review', hint: 'Pending units' },
    ],
  },
  {
    label: 'Pipeline',
    tabs: [
      { id: 'traces', label: 'Ingest', hint: 'Traces → units' },
      { id: 'scenarios', label: 'Scenarios', hint: 'L2 layer' },
      { id: 'assets', label: 'Assets', hint: 'Skills · wiki · codegraph' },
      { id: 'persona', label: 'Persona', hint: 'L3 profile' },
    ],
  },
  {
    label: 'System',
    tabs: [
      { id: 'settings', label: 'Settings', hint: 'Auth · workspaces · providers' },
    ],
  },
];

const TAB_TITLES: Record<Tab, string> = {
  login: 'Login',
  dashboard: 'Overview',
  activity: 'Activity',
  zones: 'Zones',
  graph: 'Graph',
  search: 'Search',
  units: 'Units',
  traces: 'Ingest',
  scenarios: 'Scenarios',
  assets: 'Assets',
  persona: 'Persona',
  'working-memory': 'Working Memory',
  review: 'Review',
  settings: 'Settings',
};

export function App() {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  const tab = route.tab;
  const [ok, setOk] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [pulse, setPulse] = useState(0);
  const [ws, setWs] = useState(api.getWorkspace());
  const [workspaces, setWorkspaces] = useState<Array<{ slug: string; name: string }>>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [zones, setZones] = useState<Zone[]>([]);
  const [activeZone, setActiveZone] = useState('');

  const searchQFromUrl = () => new URLSearchParams(window.location.search).get('q') || '';

  useEffect(() => {
    // Legacy hash routes (e.g. /#/graph) → path routes.
    const hash = window.location.hash.replace(/^#\/?/, '');
    const legacy = TABS.find((t) => t.id === hash);
    if (legacy) {
      window.history.replaceState(null, '', tabPath(legacy.id));
      setRoute({ tab: legacy.id });
    } else if (hash) {
      window.history.replaceState(null, '', '/');
      setRoute({ tab: DEFAULT_TAB });
    }

    const onPop = () => {
      const r = parsePath(window.location.pathname);
      setRoute(r);
      if (r.tab === 'search') setSearchQuery(searchQFromUrl());
    };
    window.addEventListener('popstate', onPop);
    // Restore a shareable /search?q=... deep link on first paint.
    if (route.tab === 'search') {
      const q = searchQFromUrl();
      if (q) setSearchQuery(q);
    }
    // Canonicalize root/unknown paths so the address bar always shows the
    // active route (e.g. "/" → "/activity", "/nope" → "/activity").
    if (!route.unitId && window.location.pathname !== canonicalPath(route)) {
      window.history.replaceState(null, '', canonicalPath(route));
    }
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    document.title = route.unitId
      ? `Amem — Unit ${route.unitId}`
      : `Amem — ${TAB_TITLES[route.tab]}`;
  }, [route]);

  const refreshMeta = () => {
    api
      .me()
      .then((m) => {
        setMe(m);
        setWorkspaces(m.workspaces || []);
        setWs(m.workspace?.slug || api.getWorkspace());
      })
      .catch(() => {
        // 401 / no valid token: if the server requires auth, gate on login.
        setMe((cur) => cur ?? {
          realm: 'local',
          authEnabled: true,
          user: null,
          workspace: { id: '', slug: api.getWorkspace(), name: '' },
          scopes: [],
          workspaces: [],
        });
      });
  };

  useEffect(() => {
    api.health().then(() => setOk(true)).catch(() => setOk(false));
    refreshMeta();
  }, []);

  useEffect(() => {
    // Visiting /login while already authenticated → land on the dashboard.
    if (tab === 'login' && me && (!me.authEnabled || me.user)) {
      const path = tabPath('dashboard');
      window.history.replaceState(null, '', path);
      setRoute({ tab: 'dashboard' });
    }
  }, [tab, me]);

  useEffect(() => {
    api.zones()
      .then((zs) => {
        setZones(zs);
        setActiveZone((cur) => (cur && zs.some((z) => z.id === cur) ? cur : ''));
      })
      .catch(() => setZones([]));
  }, [ws]);

  useEffect(() => {
    const id = window.setInterval(() => {
      api.activity({ limit: 1 })
        .then((ev) => setPulse(ev.length))
        .catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(id);
  }, []);

  const go = (t: Tab, unitId?: string) => {
    const path = unitId ? unitPath(unitId) : tabPath(t);
    if (window.location.pathname === path) return;
    window.history.pushState(null, '', path);
    setRoute(unitId ? { tab: 'units', unitId } : { tab: t });
  };

  const navigate = (e: React.MouseEvent, t: Tab) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    go(t);
  };

  const openSearch = (query: string) => {
    setSearchQuery(query);
    const path = tabPath('search') + (query ? `?q=${encodeURIComponent(query)}` : '');
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setRoute({ tab: 'search' });
  };

  const needsLogin = !!me && me.authEnabled && !me.user;
  if (needsLogin) {
    return <Login onAuthed={refreshMeta} />;
  }

  return (
    <div className="layout">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand-row">
            <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2.4 20.4 7v10L12 21.6 3.6 17V7z" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="3.1" fill="currentColor" />
              <path d="M12 8.9v6.2M8.9 12h6.2" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
            </svg>
            <span className="brand">Amem</span>
            <span className="brand-badge">LOCAL</span>
          </div>
          <span className={`status-dot ${ok === null ? '' : ok ? 'up' : 'down'}`}>
            <i className="status-dot-pip" />
            {ok === null ? 'connecting…' : ok ? 'API connected' : 'API unavailable'}
          </span>
          <GlobalSearch
            onOpenUnit={(id) => go('units', id)}
            onOpenSearch={openSearch}
          />
          <label className="ws-field">
            <span className="ws-label">Workspace</span>
            <select
              className="ws-select"
              value={ws}
              onChange={(e) => {
                api.setWorkspace(e.target.value);
                setWs(e.target.value);
              }}
              title="Active workspace"
            >
              {(workspaces.length ? workspaces : [{ slug: ws, name: ws }]).map((w) => (
                <option key={w.slug} value={w.slug}>
                  {w.name || w.slug}
                </option>
              ))}
            </select>
          </label>
        </div>
        <nav className="side-nav">
          {NAV_SECTIONS.map((section) => (
            <div className="nav-section" key={section.label}>
              <div className="nav-label">{section.label}</div>
              {section.tabs.map((t) => (
                <a
                  key={t.id}
                  href={TABS.find((x) => x.id === t.id)!.path}
                  className={tab === t.id ? 'active' : ''}
                  onClick={(e) => navigate(e, t.id)}
                  title={t.hint}
                >
                  <span className="nav-item-label">
                    {t.label}
                    {t.id === 'activity' && pulse > 0 ? <i className="nav-live" title="new activity" /> : null}
                  </span>
                  <span className="nav-item-hint">{t.hint}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="main" id="main">
        <div className="wrap" key={ws}>
          {tab === 'dashboard' && (
            <Dashboard zones={zones} activeZone={activeZone} onZoneChange={setActiveZone} />
          )}
          {tab === 'activity' && <Activity onOpenUnit={(id) => go('units', id)} />}
          {tab === 'zones' && <Zones />}
          {tab === 'graph' && <GraphView onOpenUnit={(id) => go('units', id)} />}
          {tab === 'search' && (
            <Search
              key={searchQuery}
              initialQuery={searchQuery}
              zones={zones}
              zone={activeZone}
              onZoneChange={setActiveZone}
            />
          )}
          {tab === 'units' && (
            <Units
              unitId={route.unitId ?? null}
              onSelectUnit={(id) => go('units', id || undefined)}
              zones={zones}
              zone={activeZone}
              onZoneChange={setActiveZone}
            />
          )}
          {tab === 'traces' && <Traces />}
          {tab === 'scenarios' && <Scenarios />}
          {tab === 'assets' && <Assets />}
          {tab === 'persona' && <PersonaView />}
          {tab === 'working-memory' && <WorkingMemory />}
          {tab === 'review' && <Review />}
          {tab === 'settings' && <Settings onAuthChange={refreshMeta} />}
        </div>
      </main>
    </div>
  );
}
