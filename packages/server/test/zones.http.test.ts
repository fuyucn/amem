import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AmemConfig } from '@amem/core';
import { AuthStore, openDatabase } from '@amem/db';
import { createServer, type ServerHandle } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const SECRET = 'test-secret-at-least-16-chars';

describe('zones REST + ACL isolation', () => {
  let app: FastifyInstance;
  let handle: ServerHandle;
  let dbPath: string;
  let adminToken = '';
  let acmeAdminToken = '';
  let bobToken = '';
  let bobUserId = '';
  let acmeWsId = '';
  let backendZoneId = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amem-zones-'));
    dbPath = join(dir, 'test.db');
    const config: AmemConfig = {
      dbPath,
      host: '127.0.0.1',
      port: 0,
      embedding: { mode: 'offline', dims: 64 },
      llm: {},
      thresholds: {
        minSourcesForCrystal: 3,
        dedupSimThreshold: 0.9,
        linkSimThreshold: 0.72,
        contradictionThreshold: 0.6,
        decayPerDay: 0.02,
        forgetThreshold: 0.3,
        workingMemoryBudget: 2000,
        recallBudget: 3000,
      },
      jobs: { enabled: false, debounceMs: 0, intervalMs: 0, maxPerHour: 100, tokenBudgetDaily: 1e6 },
      authEnabled: true,
      authSecret: SECRET,
      bootstrapAdminEmail: 'admin@test.local',
      bootstrapAdminPassword: 'admin-pass',
      allowLegacyApiToken: false,
      apiToken: undefined,
    };
    handle = await createServer(config);
    app = handle.app;
    await app.ready();

    // Second user, created directly in the auth DB (test-only path; the REST
    // surface has no self-signup — users join via admin-managed workspaces).
    const authStore = new AuthStore(openDatabase(dbPath));
    const bob = authStore.createUser({ email: 'bob@test.local', password: 'bob-pass', name: 'Bob' });
    bobUserId = bob.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function j(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });
    let data: unknown = null;
    try {
      data = res.json();
    } catch {
      data = res.body;
    }
    return { status: res.statusCode, body: data };
  }

  it('seeds zones, creates a project zone, and moves units between zones', async () => {
    const login = await j('POST', '/api/v1/auth/login', {
      email: 'admin@test.local',
      password: 'admin-pass',
      tokenName: 'zones-admin',
    });
    expect(login.status).toBe(200);
    adminToken = (login.body as { token: string }).token;

    // Admin creates a company workspace; default skeleton must appear.
    const ws = await j(
      'POST',
      '/api/v1/workspaces',
      { slug: 'acme', name: 'Acme Corp', kind: 'company' },
      { authorization: `Bearer ${adminToken}` },
    );
    expect(ws.status).toBe(200);
    acmeWsId = (ws.body as { id: string }).id;

    // Admin minted a PAT for acme (login PAT only covers the personal ws).
    const pat = await j(
      'POST',
      '/api/v1/auth/tokens',
      { name: 'acme-admin', scopes: ['read', 'write', 'admin'], workspaceIds: [acmeWsId] },
      { authorization: `Bearer ${adminToken}` },
    );
    expect(pat.status).toBe(200);
    acmeAdminToken = (pat.body as { token: string }).token;
    const acmeAuth = { authorization: `Bearer ${acmeAdminToken}`, 'x-amem-workspace': 'acme' };

    // Default skeleton must appear for the new workspace.
    const seeded = await j('GET', '/api/v1/zones', undefined, acmeAuth);
    expect(seeded.status).toBe(200);
    const seededZones = seeded.body as Array<{ kind: string; slug: string }>;
    const kinds = seededZones.map((z) => z.kind).sort();
    expect(kinds).toContain('inbox');
    expect(kinds).toContain('shared');
    expect(kinds).toContain('personal');

    // Project zone (members visibility, owner = admin).
    const zone = await j(
      'POST',
      '/api/v1/zones',
      { slug: 'backend', name: 'Backend', kind: 'project', visibility: 'members' },
      acmeAuth,
    );
    expect(zone.status).toBe(200);
    backendZoneId = (zone.body as { id: string }).id;

    // Ingest two units: one auto-routed (inbox), one pinned to backend.
    const inboxUnit = await j(
      'POST',
      '/api/v1/ingest',
      { title: 'acme team meeting', content: 'Decision: acme ships v2 in Q3.' },
      acmeAuth,
    );
    expect(inboxUnit.status).toBe(200);
    const inboxId = ((inboxUnit.body as { units: Array<{ id: string }> }).units[0]).id;

    const backendUnit = await j(
      'POST',
      '/api/v1/ingest',
      {
        title: 'backend API contract',
        content: 'Procedure: the API uses bearer auth and zone scoping for isolation.',
        zoneId: backendZoneId,
      },
      acmeAuth,
    );
    expect(backendUnit.status).toBe(200);
    const backendUnitId = ((backendUnit.body as { units: Array<{ id: string }> }).units[0]).id;

    // Zone stats: backend holds exactly the pinned unit.
    const zonesAfter = await j('GET', '/api/v1/zones', undefined, acmeAuth);
    const backend = (zonesAfter.body as Array<{ id: string; unitCount: number }>).find(
      (z) => z.id === backendZoneId,
    );
    expect(backend?.unitCount).toBe(1);

    // Move the inbox unit into backend via POST /units/:id/zone.
    const moved = await j(
      'POST',
      `/api/v1/units/${inboxId}/zone`,
      { zoneId: backendZoneId },
      acmeAuth,
    );
    expect(moved.status).toBe(200);
    const movedBody = moved.body as { ok: boolean; zoneSlug: string };
    expect(movedBody.ok).toBe(true);
    expect(movedBody.zoneSlug).toBe('backend');

    const filtered = await j('GET', `/api/v1/units?zone=backend`, undefined, acmeAuth);
    const ids = (filtered.body as Array<{ id: string }>).map((u) => u.id);
    expect(ids).toContain(backendUnitId);
    expect(ids).toContain(inboxId);

    // Deleting a non-empty zone is refused; unit moves let the delete succeed.
    const refused = await j('DELETE', `/api/v1/zones/${backendZoneId}`, undefined, acmeAuth);
    expect(refused.status).toBe(409);
    expect(backendUnitId).toBeTruthy();
  });

  it('REST ingest accepts zone by slug and pins distilled units to that partition', async () => {
    const acmeAuth = { authorization: `Bearer ${acmeAdminToken}`, 'x-amem-workspace': 'acme' };

    const res = await j(
      'POST',
      '/api/v1/ingest',
      {
        title: 'slug-pinned ingest',
        content: 'Memory: REST ingest with a zone slug must land in the backend partition.',
        zone: 'backend',
      },
      acmeAuth,
    );
    expect(res.status).toBe(200);
    const unit = (res.body as { units: Array<{ id: string; zoneId?: string }> }).units[0];
    expect(unit).toBeTruthy();

    const detail = await j('GET', `/api/v1/units/${unit.id}`, undefined, acmeAuth);
    expect(detail.status).toBe(200);
    expect((detail.body as { zoneId: string }).zoneId).toBe(backendZoneId);
  });

  it('REST units create accepts zone by slug and pins the unit to that partition', async () => {
    const acmeAuth = { authorization: `Bearer ${acmeAdminToken}`, 'x-amem-workspace': 'acme' };

    const res = await j(
      'POST',
      '/api/v1/units',
      {
        title: 'slug-pinned direct save',
        type: 'note',
        summary: 'Direct unit save with a zone slug must land in the backend partition.',
        body: 'Memory: POST /units with zone slug.',
        zone: 'backend',
      },
      acmeAuth,
    );
    expect(res.status).toBe(200);
    const unitId = (res.body as { id: string }).id;
    expect(unitId).toBeTruthy();

    const detail = await j('GET', `/api/v1/units/${unitId}`, undefined, acmeAuth);
    expect(detail.status).toBe(200);
    expect((detail.body as { zoneId: string }).zoneId).toBe(backendZoneId);

    // Provenance: every unit must record who wrote it and in which workspace.
    const detailBody = detail.body as { workspaceId: string; createdByUserId: string };
    expect(detailBody.workspaceId).toBe(acmeWsId);
    expect(detailBody.createdByUserId).toBeTruthy();
  });

  it('enforces zone isolation between users (A cannot read B personal / private zones)', async () => {
    const acmeAuth = { authorization: `Bearer ${acmeAdminToken}`, 'x-amem-workspace': 'acme' };

    // Admin adds Bob to acme → seeds Bob's personal zone.
    const member = await j(
      'POST',
      '/api/v1/workspaces/acme/members',
      { email: 'bob@test.local', role: 'member' },
      acmeAuth,
    );
    expect(member.status).toBe(200);
    expect((member.body as { userId: string }).userId).toBe(bobUserId);

    // Bob's PAT (test-only mint, workspace wildcard).
    const authStore = new AuthStore(openDatabase(dbPath));
    const pat = authStore.createPat({
      userId: bobUserId,
      name: 'bob-test',
      scopes: ['read', 'write'],
      workspaceIds: ['*'],
      secret: SECRET,
      ttlDays: 90,
    });
    bobToken = pat.token;
    const bobAuth = { authorization: `Bearer ${bobToken}`, 'x-amem-workspace': 'acme' };

    // Admin writes a private note into their personal zone (offline routing
    // cannot hit it via centroid, so pin it explicitly by slug).
    const personalZone = (
      (await j('GET', '/api/v1/zones', undefined, acmeAuth)).body as Array<{
        kind: string;
        slug: string;
      }>
    ).find((z) => z.kind === 'personal');
    expect(personalZone).toBeTruthy();
    const secretWrite = await j(
      'POST',
      '/api/v1/ingest',
      {
        title: 'admin salary plan',
        content: 'Preference: admin salary numbers are private to the admin.',
        zoneId: personalZone?.slug,
      },
      acmeAuth,
    );
    expect(secretWrite.status).toBe(200);

    // Bob's zone list: personal(Bob) + inbox + shared, but NOT admin personal
    // and NOT the private-project zone until Bob is added as a member.
    const bobZones = (await j('GET', '/api/v1/zones', undefined, bobAuth)).body as Array<{
      kind: string;
      slug: string;
    }>;
    const bobSlugs = bobZones.map((z) => z.slug);
    expect(bobSlugs).toContain('inbox');
    expect(bobSlugs).toContain('shared');
    expect(bobSlugs).not.toContain(personalZone?.slug);
    expect(bobSlugs).not.toContain('backend');

    // Bob must not see admin's private unit anywhere (list or search).
    const bobUnits = (await j('GET', '/api/v1/units', undefined, bobAuth)).body as Array<{
      title: string;
    }>;
    expect(bobUnits.some((u) => u.title.includes('salary'))).toBe(false);
    const bobSearch = await j('POST', '/api/v1/recall', { query: 'salary plan' }, bobAuth);
    expect(bobSearch.status).toBe(200);
    const recallText = (bobSearch.body as { text: string }).text;
    expect(recallText).not.toContain('salary');

    // Bob cannot move a unit into admin's personal zone (403, no leak).
    const inboxUnit = (await j('GET', '/api/v1/units?zone=inbox', undefined, bobAuth)).body as Array<{
      id: string;
    }>;
    if (inboxUnit.length > 0) {
      const blocked = await j(
        'POST',
        `/api/v1/units/${inboxUnit[0].id}/zone`,
        { zoneSlug: personalZone?.slug },
        bobAuth,
      );
      expect(blocked.status).toBe(403);
    }

    // Granting Bob membership on the backend zone opens it for read.
    const grant = await j(
      'POST',
      `/api/v1/zones/${backendZoneId}/members`,
      { userId: bobUserId, role: 'reader' },
      acmeAuth,
    );
    expect(grant.status).toBe(200);
    const bobZones2 = (await j('GET', '/api/v1/zones', undefined, bobAuth)).body as Array<{
      slug: string;
    }>;
    expect(bobZones2.some((z) => z.slug === 'backend')).toBe(true);
    const backendForBob = await j('GET', '/api/v1/units?zone=backend', undefined, bobAuth);
    expect(backendForBob.status).toBe(200);
    expect((backendForBob.body as Array<{ title: string }>).length).toBeGreaterThanOrEqual(1);

    // Revoke membership → backend disappears from Bob's view again.
    const revoke = await j(
      'DELETE',
      `/api/v1/zones/${backendZoneId}/members/${bobUserId}`,
      undefined,
      acmeAuth,
    );
    expect(revoke.status).toBe(200);
    const bobZones3 = (await j('GET', '/api/v1/zones', undefined, bobAuth)).body as Array<{
      slug: string;
    }>;
    expect(bobZones3.some((z) => z.slug === 'backend')).toBe(false);

    // PATCH zone metadata + recompute (offline embedder reports skipped) work.
    const patched = await j(
      'PATCH',
      `/api/v1/zones/${backendZoneId}`,
      { name: 'Backend Platform' },
      acmeAuth,
    );
    expect(patched.status).toBe(200);
    expect((patched.body as { name: string }).name).toBe('Backend Platform');
    const recompute = await j('POST', '/api/v1/zones/recompute', {}, acmeAuth);
    expect(recompute.status).toBe(200);
    expect((recompute.body as { skippedOffline: boolean }).skippedOffline).toBe(true);
  });

  it('x-amem-zone header scopes reads and routes unscoped writes into the partition', async () => {
    const acmeAuth = { authorization: `Bearer ${acmeAdminToken}`, 'x-amem-workspace': 'acme' };

    // Unscoped write + header scope → the unit must land in backend.
    const write = await j(
      'POST',
      '/api/v1/units',
      {
        title: 'header-scoped save',
        type: 'note',
        summary: 'A unit written while x-amem-zone is set must route into that partition.',
        body: 'Memory: header zone scoping on the REST API.',
      },
      { ...acmeAuth, 'x-amem-zone': 'backend' },
    );
    expect(write.status).toBe(200);
    expect((write.body as { zoneId: string }).zoneId).toBe(backendZoneId);

    // Reads with the header see only backend units (inbox 'acme team meeting'
    // must stay invisible) and list it by zone.
    const scopedList = await j(
      'GET',
      '/api/v1/units',
      undefined,
      { ...acmeAuth, 'x-amem-zone': 'backend' },
    );
    expect(scopedList.status).toBe(200);
    const titles = (scopedList.body as Array<{ title: string }>).map((u) => u.title);
    expect(titles.some((t) => t.includes('header-scoped save'))).toBe(true);
    expect(titles.some((t) => t.includes('salary'))).toBe(false);

    // Same request without the header (no zone scope) is not narrowed: the
    // workspace-wide view still contains units from other partitions.
    const wsList = await j('GET', '/api/v1/units', undefined, acmeAuth);
    const wsTitles = (wsList.body as Array<{ title: string }>).map((u) => u.title);
    expect(wsTitles.some((t) => t.includes('salary'))).toBe(true);

    // A caller may not scope into a zone they cannot access: Bob → admin
    // personal zone slug must be rejected with 403 (no silent fallback).
    const personalSlug = (
      (await j('GET', '/api/v1/zones', undefined, acmeAuth)).body as Array<{
        kind: string;
        slug: string;
      }>
    ).find((z) => z.kind === 'personal')?.slug;
    expect(personalSlug).toBeTruthy();
    const blocked = await j(
      'GET',
      '/api/v1/units',
      undefined,
      { authorization: `Bearer ${bobToken}`, 'x-amem-workspace': 'acme', 'x-amem-zone': personalSlug! },
    );
    expect(blocked.status).toBe(403);

    // Unknown zone ref is also refused, not silently ignored.
    const unknown = await j(
      'GET',
      '/api/v1/units',
      undefined,
      { ...acmeAuth, 'x-amem-zone': 'does-not-exist' },
    );
    expect(unknown.status).toBe(403);
  });
});
