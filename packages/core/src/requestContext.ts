import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_WORKSPACE_ID = 'ws_personal';
export const DEFAULT_WORKSPACE_SLUG = 'personal';

export interface RequestContext {
  workspaceId: string;
  workspaceSlug: string;
  userId?: string;
  scopes: string[];
  realm: 'anonymous' | 'legacy' | 'user' | 'pat';
  authEnabled: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    return {
      workspaceId: DEFAULT_WORKSPACE_ID,
      workspaceSlug: DEFAULT_WORKSPACE_SLUG,
      scopes: ['read', 'write', 'admin'],
      realm: 'anonymous',
      authEnabled: false,
    };
  }
  return ctx;
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export async function runWithRequestContextAsync<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

/** Bind context for the rest of the current async resource (Fastify onRequest). */
export function enterRequestContext(ctx: RequestContext): void {
  storage.enterWith(ctx);
}

export function hasScope(ctx: RequestContext, need: 'read' | 'write' | 'admin'): boolean {
  if (ctx.scopes.includes('admin')) return true;
  if (need === 'read') return ctx.scopes.includes('read') || ctx.scopes.includes('write');
  if (need === 'write') return ctx.scopes.includes('write');
  return ctx.scopes.includes('admin');
}
