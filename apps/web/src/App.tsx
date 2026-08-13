import { useEffect, useState } from 'react';
import { api } from './api';
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
import { SetupWizard } from './views/SetupWizard';
import { canonicalPath, DEFAULT_TAB, parsePath, tabPath, unitPath, type Route, type Tab } from './router';

const TABS: Array<{ id: Tab; label: string; path: string }> = [
  { id: 'dashboard', label: 'Overview', path: '/dashboard' },
  { id: 'activity', label: 'Activity', path: '/activity' },
  { id: 'graph', label: 'Graph', path: '/graph' },
  { id: 'search', label: 'Search', path: '/search' },
  { id: 'units', label: 'Units', path: '/units' },
  { id: 'traces', label: 'Ingest', path: '/traces' },
  { id: 'scenarios', label: 'Scenarios', path: '/scenarios' },
  { id: 'assets', label: 'Assets', path: '/assets' },
  { id: 'persona', label: 'Persona', path: '/persona' },
  { id: 'working-memory', label: 'Working Memory', path: '/working-memory' },
  { id: 'review', label: 'Review', path: '/review' },
  { id: 'setup', label: 'Setup', path: '/setup' },
  { id: 'settings', label: 'Settings', path: '/settings' },
];

const NAV_SECTIONS: Array<{ label: string; tabs: Array<{ id: Tab; label: string; hint: string }> }> = [
  {
    label: 'Overview',
    tabs: [
      { id: 'dashboard', label: 'Overview', hint: 'Stats · data flow' },
      { id: 'activity', label: 'Activity', hint: 'Live feed' },
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
      { id: 'setup', label: 'Setup', hint: 'First-run wizard' },
      { id: 'settings', label: 'Settings', hint: 'Auth · workspaces · providers' },
    ],
  },
];

const TAB_TITLES: Record<Tab, string> = {
  dashboard: 'Overview',
  activity: 'Activity',
  graph: 'Graph',
  search: 'Search',
  units: 'Units',
  traces: 'Ingest',
  scenarios: 'Scenarios',
  assets: 'Assets',
  persona: 'Persona',
  'working-memory': 'Working Memory',
  review: 'Review',
  setup: 'Setup',
  settings: 'Settings',
};

export function App() {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  const tab = route.tab;
  const [ok, setOk] = useState<boolean | null>(null);
  const [pulse, setPulse] = useState(0);
  const [ws, setWs] = useState(api.getWorkspace());
  const [workspaces, setWorkspaces] = useState<Array<{ slug: string; name: string }>>([]);
  const [searchQuery, setSearchQuery] = useState('');

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
        setWorkspaces(m.workspaces || []);
        setWs(m.workspace?.slug || api.getWorkspace());
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    api.health().then(() => setOk(true)).catch(() => setOk(false));
    refreshMeta();
  }, []);

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

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">Amem</span>
          <span className="muted status-dot">{ok === null ? '…' : ok ? '✓ connected' : '✗ API unavailable'}</span>
          <GlobalSearch
            onOpenUnit={(id) => go('units', id)}
            onOpenSearch={openSearch}
          />
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
                    {t.id === 'activity' && pulse > 0 ? ' ·' : ''}
                  </span>
                  <span className="nav-item-hint">{t.hint}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="main">
        <div className="wrap" key={ws}>
          {tab === 'dashboard' && <Dashboard />}
          {tab === 'activity' && <Activity onOpenUnit={(id) => go('units', id)} />}
          {tab === 'graph' && <GraphView onOpenUnit={(id) => go('units', id)} />}
          {tab === 'search' && <Search key={searchQuery} initialQuery={searchQuery} />}
          {tab === 'units' && (
            <Units
              unitId={route.unitId ?? null}
              onSelectUnit={(id) => go('units', id || undefined)}
            />
          )}
          {tab === 'traces' && <Traces />}
          {tab === 'scenarios' && <Scenarios />}
          {tab === 'assets' && <Assets />}
          {tab === 'persona' && <PersonaView />}
          {tab === 'working-memory' && <WorkingMemory />}
          {tab === 'review' && <Review />}
          {tab === 'setup' && <SetupWizard />}
          {tab === 'settings' && <Settings onAuthChange={refreshMeta} />}
        </div>
      </main>
    </div>
  );
}
