export type Tab =
  | 'dashboard'
  | 'activity'
  | 'zones'
  | 'graph'
  | 'search'
  | 'units'
  | 'traces'
  | 'scenarios'
  | 'assets'
  | 'persona'
  | 'working-memory'
  | 'review'
  | 'settings';

export interface Route {
  tab: Tab;
  unitId?: string;
}

const TAB_PATHS: Record<Tab, string> = {
  dashboard: '/dashboard',
  activity: '/activity',
  zones: '/zones',
  graph: '/graph',
  search: '/search',
  units: '/units',
  traces: '/traces',
  scenarios: '/scenarios',
  assets: '/assets',
  persona: '/persona',
  'working-memory': '/working-memory',
  review: '/review',
  settings: '/settings',
};

export const DEFAULT_TAB: Tab = 'activity';

export function tabPath(tab: Tab): string {
  return TAB_PATHS[tab];
}

export function unitPath(unitId: string): string {
  return `/units/${encodeURIComponent(unitId)}`;
}

export function canonicalPath(route: Route): string {
  if (route.unitId) return unitPath(route.unitId);
  return TAB_PATHS[route.tab];
}

export function parsePath(pathname: string): Route {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/') return { tab: DEFAULT_TAB };
  const unitMatch = clean.match(/^\/units\/(.+)$/);
  if (unitMatch?.[1]) {
    return { tab: 'units', unitId: decodeURIComponent(unitMatch[1]) };
  }
  const entry = (Object.entries(TAB_PATHS) as Array<[Tab, string]>).find(([, p]) => p === clean);
  if (entry) return { tab: entry[0] };
  return { tab: DEFAULT_TAB };
}
