import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { OauthStore } from '@amem/db';
import { hashToken } from '@amem/db';
import { AmemError } from '@amem/core';

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function verifyPkce(verifier: string, challenge: string, method = 'S256'): boolean {
  if (method === 'plain') return verifier === challenge;
  const left = Buffer.from(pkceS256(verifier));
  const right = Buffer.from(challenge);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function newOpaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(24).toString('base64url')}`;
}

export function issueTokenPair(
  store: OauthStore,
  secret: string,
  input: {
    userId: string;
    clientId: string | null;
    scopes: string[];
    workspaceIds: string[];
    accessTtlSec?: number;
    refreshTtlSec?: number;
    familyId?: string;
  },
) {
  const familyId = input.familyId || randomUUID();
  const access = newOpaqueToken('amem_atk_');
  const refresh = newOpaqueToken('amem_rtk_');
  const accessTtl = input.accessTtlSec ?? 15 * 60;
  const refreshTtl = input.refreshTtlSec ?? 30 * 24 * 3600;
  const now = Date.now();
  store.saveOauthToken({
    id: `atk_${randomUUID().slice(0, 8)}`,
    tokenHash: hashToken(secret, access),
    clientId: input.clientId,
    userId: input.userId,
    type: 'access',
    scopes: input.scopes,
    workspaceIds: input.workspaceIds,
    expiresAt: new Date(now + accessTtl * 1000).toISOString(),
    familyId,
  });
  store.saveOauthToken({
    id: `rtk_${randomUUID().slice(0, 8)}`,
    tokenHash: hashToken(secret, refresh),
    clientId: input.clientId,
    userId: input.userId,
    type: 'refresh',
    scopes: input.scopes,
    workspaceIds: input.workspaceIds,
    expiresAt: new Date(now + refreshTtl * 1000).toISOString(),
    familyId,
  });
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: accessTtl,
    scope: input.scopes.join(' '),
  };
}

export function requireRedirectAllowed(
  clientRedirects: string[] | string,
  redirectUri: string,
  opts?: { allowLoopback?: boolean },
): void {
  let allowed: string[] = [];
  try {
    allowed = Array.isArray(clientRedirects)
      ? clientRedirects
      : (JSON.parse(clientRedirects || '[]') as string[]);
  } catch {
    allowed = [];
  }
  if (allowed.includes(redirectUri)) return;
  // Public native apps (Codex) often use ephemeral localhost callback ports.
  if (opts?.allowLoopback) {
    try {
      const u = new URL(redirectUri);
      if ((u.protocol === 'http:' || u.protocol === 'https:') &&
          (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) {
        return;
      }
    } catch {
      /* fallthrough */
    }
  }
  throw new AmemError('VALIDATION', `redirect_uri not allowed: ${redirectUri}`);
}

export function authHtmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e8ee;margin:0;padding:24px}
.card{max-width:420px;margin:40px auto;background:#171a21;border:1px solid #2a2f3a;border-radius:12px;padding:20px}
h1{font-size:18px;margin:0 0 12px}label{display:block;margin:10px 0 4px;color:#9aa2b1}
input,button{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a2f3a;background:#1e222b;color:#e6e8ee}
button{background:#4f8cff;border-color:#4f8cff;color:#fff;font-weight:600;cursor:pointer;margin-top:14px}
.err{color:#ef5350;margin-top:10px}.muted{color:#9aa2b1;font-size:12px;margin-top:8px}
</style></head><body><div class="card">${body}</div></body></html>`;
}
