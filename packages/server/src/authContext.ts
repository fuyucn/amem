// Mirror of core ALS so server can enterWith without exporting private ALS from core.
// Storage in db uses core's requireRequestContext — they MUST be the same ALS instance.
// Therefore re-export enter from core by patching core requestContext.
import {
  enterRequestContext,
  getZoneAccessSync,
  runWithRequestContext,
  type RequestContext,
  type ZoneLookup,
} from '@amem/core';

/**
 * Enter the request context, and when the caller is an authenticated user
 * (PAT / OAuth), attach the zone partitions they may access (`zoneIds`).
 *
 * Anonymous and legacy callers stay unscoped (workspace-wide), preserving
 * pre-zone behavior. The zone lookup runs inside the context so storage
 * resolves the request's own workspaceId. When a workspace has zones but the
 * user has no access, `zoneIds` is `[]` → storage filters to zero rows
 * (deny), never a silent fallback to full access.
 *
 * Must stay synchronous: Fastify's ALS (`enterWith`) only propagates into the
 * route handler when it runs during the hook's synchronous phase — an `await`
 * before `enterWith` loses the context (handlers then read the default
 * workspace and see an empty zone set).
 */
export function enterRequestContextWithZones(
  ctx: RequestContext,
  storage: ZoneLookup,
): RequestContext {
  let finalCtx = ctx;
  if (ctx.userId) {
    finalCtx = runWithRequestContext(ctx, () => {
      const zones = storage.listZonesSync();
      if (zones.length === 0) return ctx; // workspace not seeded yet → legacy behavior
      const access = getZoneAccessSync(storage, ctx.userId as string);
      return { ...ctx, zoneIds: access.zoneIds };
    });
  }
  enterRequestContext(finalCtx);
  return finalCtx;
}

/**
 * Apply an explicit `x-amem-zone` request scope (id or slug) on top of an
 * already-entered context. The zone must exist in the context's workspace and
 * (for authenticated users) be inside the caller's accessible set. Otherwise
 * the request is rejected (never a silent fallback to full visibility).
 *
 * Synchronous like {@link enterRequestContextWithZones}: ALS enterWith must
 * happen in the hook's sync phase so Fastify handlers inherit the scope.
 */
export function enterRequestContextWithZoneScope(
  ctx: RequestContext,
  storage: ZoneLookup,
  zoneRef: string,
): { ok: true; ctx: RequestContext } | { ok: false } {
  const resolved = runWithRequestContext(ctx, () => {
    const zone = storage
      .listZonesSync()
      .find((z) => (z.id === zoneRef || z.slug === zoneRef) && z.status === 'active');
    if (!zone) return null;
    if (ctx.zoneIds !== undefined && !ctx.zoneIds.includes(zone.id)) return null;
    return { ...ctx, zoneIds: [zone.id] };
  });
  if (!resolved) return { ok: false };
  enterRequestContext(resolved);
  return { ok: true, ctx: resolved };
}
