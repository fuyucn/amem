const TOKEN_KEY = 'amem_token';
const WS_KEY = 'amem_workspace';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token: string) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getWorkspaceSlug(): string {
  return localStorage.getItem(WS_KEY) || 'personal';
}
export function setWorkspaceSlug(slug: string) {
  localStorage.setItem(WS_KEY, slug || 'personal');
}
export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'x-amem-workspace': getWorkspaceSlug() };
  const t = getToken();
  if (t) h.authorization = `Bearer ${t}`;
  return h;
}
