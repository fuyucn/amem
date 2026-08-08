import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AmemConfig, RequestContext } from '@amem/core';
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_SLUG,
  hasScope,
} from '@amem/core';
import { AuthStore, OauthStore, verifyPassword, hashToken, type WorkspaceRow } from '@amem/db';
import { AmemError } from '@amem/core';

export interface ResolvedAuth {
  ctx: RequestContext;
  workspace: WorkspaceRow;
}

function ensureSecret(config: AmemConfig): string {
  if (config.authSecret && config.authSecret.length >= 16) return config.authSecret;
  // Persist generated secret next to DB so PATs survive restarts.
  const dir = path.dirname(config.dbPath);
  const secretPath = path.join(dir, '.amem_auth_secret');
  try {
    if (existsSync(secretPath)) {
      const s = readFileSync(secretPath, 'utf8').trim();
      if (s.length >= 16) return s;
    }
    mkdirSync(dir, { recursive: true });
    const generated = randomBytes(32).toString('base64url');
    writeFileSync(secretPath, generated, { mode: 0o600 });
    return generated;
  } catch {
    return randomBytes(32).toString('base64url');
  }
}

export function resolveAuthSecret(config: AmemConfig): string {
  return ensureSecret(config);
}

export function createAuthStore(db: ConstructorParameters<typeof AuthStore>[0]): AuthStore {
  return new AuthStore(db);
}
export function createOauthStore(db: ConstructorParameters<typeof OauthStore>[0]): OauthStore {
  return new OauthStore(db);
}


/** Ensure default workspace exists; optionally bootstrap admin when auth enabled. */
export function bootstrapAuth(
  store: AuthStore,
  config: AmemConfig,
): { secret: string; bootstrapToken?: string; adminEmail?: string } {
  const secret = resolveAuthSecret(config);
  // Ensure default workspace row
  if (!store.getWorkspaceById(DEFAULT_WORKSPACE_ID)) {
    // AuthStore ensure via raw insert in migrate; double-check via create path for first user later.
  }

  if (!config.authEnabled) {
    return { secret };
  }

  if (store.countUsers() > 0) {
    return { secret };
  }

  const email = config.bootstrapAdminEmail || 'admin@localhost';
  const password = config.bootstrapAdminPassword || 'admin';
  const user = store.createUser({ email, password, name: 'Admin' });
  const ws = store.ensurePersonalWorkspace(user.id, 'Personal');
  const { token } = store.createPat({
    userId: user.id,
    name: 'bootstrap',
    scopes: ['read', 'write', 'admin'],
    workspaceIds: [ws.id],
    secret,
    ttlDays: config.patDefaultTtlDays ?? 90,
  });
  return { secret, bootstrapToken: token, adminEmail: email };
}

export function parseBearer(header?: string): string | undefined {
  if (!header) return undefined;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim();
}

export function resolveRequestAuth(opts: {
  config: AmemConfig;
  store: AuthStore;
  oauth?: OauthStore;
  secret: string;
  authorization?: string;
  workspaceHeader?: string;
}): ResolvedAuth {
  const { config, store, secret } = opts;
  const oauth = opts.oauth;
  const token = parseBearer(opts.authorization);
  const headerExplicit = opts.workspaceHeader !== undefined && opts.workspaceHeader.trim() !== '';
  const requestedSlug = (opts.workspaceHeader || DEFAULT_WORKSPACE_SLUG).trim();

  // Legacy static token mode: if AMEM_API_TOKEN is set, require it even when authEnabled=false.
  if (!config.authEnabled && config.apiToken) {
    if (!token || token !== config.apiToken) {
      throw new AmemError('UNAUTHORIZED', 'Invalid or missing bearer token');
    }
    let ws = store.getWorkspaceBySlug(requestedSlug);
    if (!ws) {
      if (headerExplicit) {
        throw new AmemError('FORBIDDEN', `Workspace "${requestedSlug}" not found or not permitted`);
      }
      ws = store.getWorkspaceById(DEFAULT_WORKSPACE_ID);
    }
    if (!ws) throw new AmemError('UNAUTHORIZED', 'Default workspace missing');
    return {
      workspace: ws,
      ctx: {
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        scopes: ['read', 'write', 'admin'],
        realm: 'legacy',
        authEnabled: true,
      },
    };
  }

  // Auth disabled: if caller sent a PAT/OAuth token, still honor identity;
  // otherwise anonymous full access on default/requested workspace.
  if (!config.authEnabled) {
    const looksLikeUserToken =
      !!token &&
      (token.startsWith('amem_pat_') || token.startsWith('amem_atk_'));
    if (!looksLikeUserToken) {
      let ws = store.getWorkspaceBySlug(requestedSlug);
      if (!ws) {
        if (headerExplicit) {
          throw new AmemError('FORBIDDEN', `Workspace "${requestedSlug}" not found or not permitted`);
        }
        ws =
          store.getWorkspaceById(DEFAULT_WORKSPACE_ID) ||
          ({
            id: DEFAULT_WORKSPACE_ID,
            slug: DEFAULT_WORKSPACE_SLUG,
            name: 'Personal',
            kind: 'personal' as const,
            owner_user_id: null,
            labels: '{}',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } satisfies WorkspaceRow);
      }
      return {
        workspace: ws,
        ctx: {
          workspaceId: ws.id,
          workspaceSlug: ws.slug,
          scopes: ['read', 'write', 'admin'],
          realm: 'anonymous',
          authEnabled: false,
        },
      };
    }
    // fall through to PAT/OAuth resolution below
  }

  if (!token) {
    throw new AmemError('UNAUTHORIZED', 'Missing bearer token');
  }

  // Legacy static token
  if (config.allowLegacyApiToken !== false && config.apiToken && token === config.apiToken) {
    let ws = store.getWorkspaceBySlug(requestedSlug);
    if (!ws) {
      if (headerExplicit) {
        throw new AmemError('FORBIDDEN', `Workspace "${requestedSlug}" not found or not permitted`);
      }
      ws = store.getWorkspaceById(DEFAULT_WORKSPACE_ID);
    }
    if (!ws) throw new AmemError('UNAUTHORIZED', 'Default workspace missing');
    return {
      workspace: ws,
      ctx: {
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        scopes: ['read', 'write'],
        realm: 'legacy',
        authEnabled: true,
      },
    };
  }

  // OAuth access tokens
  if (token.startsWith('amem_atk_')) {
    if (!oauth) throw new AmemError('UNAUTHORIZED', 'OAuth not available');
    const row = oauth.findOauthToken(hashToken(secret, token), 'access');
    if (!row) throw new AmemError('UNAUTHORIZED', 'Invalid or expired access token');
    const scopes = JSON.parse(row.scopes || '[]') as string[];
    const workspaceIds = JSON.parse(row.workspace_ids || '[]') as string[];
    const userWorkspaces = store.listWorkspacesForUser(row.user_id);
    const allowed = userWorkspaces.filter(
      (w) => workspaceIds.length === 0 || workspaceIds.includes(w.id) || workspaceIds.includes('*'),
    );
    if (!allowed.length) throw new AmemError('UNAUTHORIZED', 'Token has no workspaces');
    const ws = pickWorkspace(allowed, requestedSlug, headerExplicit);
    return {
      workspace: ws,
      ctx: {
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        userId: row.user_id,
        scopes: scopes.length ? scopes : ['read', 'write'],
        realm: 'user',
        authEnabled: true,
      },
    };
  }

  if (!token.startsWith('amem_pat_')) {
    throw new AmemError('UNAUTHORIZED', 'Invalid token');
  }

  const pat = store.findPatByToken(secret, token);
  if (!pat) throw new AmemError('UNAUTHORIZED', 'Invalid or revoked PAT');

  const scopes = JSON.parse(pat.scopes || '[]') as string[];
  const workspaceIds = JSON.parse(pat.workspace_ids || '[]') as string[];
  const userWorkspaces = store.listWorkspacesForUser(pat.user_id);
  const allowed = userWorkspaces.filter(
    (w) => workspaceIds.length === 0 || workspaceIds.includes(w.id) || workspaceIds.includes('*'),
  );
  if (allowed.length === 0) throw new AmemError('UNAUTHORIZED', 'PAT has no workspaces');

  const ws = pickWorkspace(allowed, requestedSlug, headerExplicit);

  const role = store.memberRole(ws.id, pat.user_id);
  if (!role) throw new AmemError('UNAUTHORIZED', 'Not a workspace member');

  const effectiveScopes = [...scopes];
  if (role === 'reader' && !effectiveScopes.includes('admin')) {
    // readers cannot write even if PAT says write
    const filtered = effectiveScopes.filter((s) => s !== 'write' && !s.endsWith(':write'));
    if (!filtered.includes('read')) filtered.push('read');
    return {
      workspace: ws,
      ctx: {
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        userId: pat.user_id,
        scopes: filtered,
        realm: 'pat',
        authEnabled: true,
      },
    };
  }

  return {
    workspace: ws,
    ctx: {
      workspaceId: ws.id,
      workspaceSlug: ws.slug,
      userId: pat.user_id,
      scopes: effectiveScopes.length ? effectiveScopes : ['read', 'write'],
      realm: 'pat',
      authEnabled: true,
    },
  };
}

function pickWorkspace(
  allowed: WorkspaceRow[],
  requestedSlug: string,
  headerExplicit: boolean,
): WorkspaceRow {
  const hit = allowed.find((w) => w.slug === requestedSlug);
  if (hit) return hit;
  if (headerExplicit) {
    throw new AmemError('FORBIDDEN', `Workspace "${requestedSlug}" is not permitted for this credential`);
  }
  return allowed[0]!;
}

export { hasScope, verifyPassword };
