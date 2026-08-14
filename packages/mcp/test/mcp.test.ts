import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '@amem/core';
import { createSqliteStorageFromPath } from '@amem/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'amem-mcp-test-'));
const dbPath = join(dir, 'test.db');
const config = mergeConfig({
  dbPath,
  embedding: { mode: 'offline', dims: 64 },
  jobs: { enabled: false },
});

describe('@amem/mcp over InMemoryTransport', () => {
  let serverHandle: Awaited<ReturnType<typeof createMcpServer>>;
  let client: Client;
  let storage: Awaited<ReturnType<typeof createSqliteStorageFromPath>>;

  beforeAll(async () => {
    storage = await createSqliteStorageFromPath(dbPath);
    serverHandle = await createMcpServer(config, { storage });
    client = new Client({ name: 'amem-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serverHandle.server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await serverHandle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('ingest');
    expect(names).toContain('recall');
    expect(names).toContain('save_unit');
    expect(names).toContain('health');
    expect(names).toContain('activity');
  });

  it('health returns ok', async () => {
    const result = await client.callTool({ name: 'health', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toBeTruthy();
    expect(JSON.parse(text).ok).toBe(true);
  });

  it('ingest returns a success result with content', async () => {
    const result = await client.callTool({
      name: 'ingest',
      arguments: { title: 'Meeting notes', content: 'We decided to use pnpm workspaces.' },
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text);
    expect(parsed.trace.title).toBe('Meeting notes');
  });

  it('search returns a success result', async () => {
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'pnpm', limit: 5 },
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toBeTruthy();
    expect(JSON.parse(text).query).toBe('pnpm');
  });

  it('zone param routes writes and reads into one partition', async () => {
    const zone = await storage.createZone({
      workspaceId: 'ws_personal',
      slug: 'mcp-proj',
      name: 'MCP Proj',
      kind: 'project',
      visibility: 'workspace',
    });

    const ingest = await client.callTool({
      name: 'ingest',
      arguments: {
        title: 'Zoned ingest probe',
        content: 'MCP zone routing must place this fact inside the mcp-proj partition.',
        zone: 'mcp-proj',
      },
    });
    expect(ingest.isError).toBeFalsy();
    const ingestParsed = JSON.parse(
      ingest.content[0]?.type === 'text' ? ingest.content[0].text : '{}',
    );
    expect(ingestParsed.units.length).toBeGreaterThanOrEqual(1);
    for (const u of ingestParsed.units) expect(u.zoneId).toBe(zone.id);

    const save = await client.callTool({
      name: 'save_unit',
      arguments: {
        unit: {
          type: 'decision',
          form: 'unit',
          title: 'Zoned save probe',
          body: 'Explicit zoneId on save_unit must be honored.',
          zoneId: 'mcp-proj',
        },
      },
    });
    expect(save.isError).toBeFalsy();
    const saved = JSON.parse(save.content[0]?.type === 'text' ? save.content[0].text : '{}');
    expect(saved.zoneId).toBe(zone.id);

    const listed = await client.callTool({
      name: 'list_units',
      arguments: { zone: 'mcp-proj' },
    });
    expect(listed.isError).toBeFalsy();
    const listedParsed = JSON.parse(
      listed.content[0]?.type === 'text' ? listed.content[0].text : '[]',
    );
    const titles = listedParsed.map((u: { title: string }) => u.title);
    expect(titles).toContain('Zoned save probe');
    expect(titles.some((t) => t.includes('MCP zone routing'))).toBe(true);
    for (const u of listedParsed) expect(u.zoneId).toBe(zone.id);

    const search = await client.callTool({
      name: 'search',
      arguments: { query: 'mcp-proj partition', zone: 'mcp-proj' },
    });
    expect(search.isError).toBeFalsy();
    const searchParsed = JSON.parse(
      search.content[0]?.type === 'text' ? search.content[0].text : '{}',
    );
    expect(searchParsed.items?.length).toBeGreaterThanOrEqual(1);

    const recall = await client.callTool({
      name: 'recall',
      arguments: { query: 'Zoned save probe', zone: 'mcp-proj' },
    });
    expect(recall.isError).toBeFalsy();
  });

  it('tool schemas expose the zone parameter', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['ingest', 'recall', 'recall_layered', 'search', 'list_units']) {
      const schema = byName.get(name)?.inputSchema;
      expect(schema, `${name} inputSchema`).toBeTruthy();
      const props = (schema as { properties?: Record<string, unknown> })?.properties ?? {};
      expect(props.zone, `${name} zone param`).toBeTruthy();
    }
  });

  it('chains tools end-to-end for a real workflow', async () => {
    // ingest a related fact
    const ingest = await client.callTool({
      name: 'ingest',
      arguments: {
        title: 'Archive policy',
        content: 'Finished work is consolidated into crystal units and archived after it decays.',
      },
    });
    expect(ingest.isError).toBeFalsy();

    // recall retrieves it with a grounded, cited context block
    const recall = await client.callTool({
      name: 'recall',
      arguments: { query: 'archive policy', tokenBudget: 400 },
    });
    expect(recall.isError).toBeFalsy();
    const rt = recall.content[0]?.type === 'text' ? recall.content[0].text : '';
    const recallParsed = JSON.parse(rt);
    expect(recallParsed.items.length).toBeGreaterThanOrEqual(1);
    expect(recallParsed.usedTokens).toBeLessThanOrEqual(400);
    expect(recallParsed.text).toContain('[unit:');

    // working memory assembles a briefing within budget
    const wm = await client.callTool({
      name: 'working_memory',
      arguments: { budget: 500 },
    });
    expect(wm.isError).toBeFalsy();
    const wmText = wm.content[0]?.type === 'text' ? wm.content[0].text : '';
    expect(JSON.parse(wmText).tokenCount).toBeLessThanOrEqual(500);

    // the knowledge graph exposes nodes from everything ingested
    const graph = await client.callTool({ name: 'get_graph', arguments: {} });
    expect(graph.isError).toBeFalsy();
    const gText = graph.content[0]?.type === 'text' ? graph.content[0].text : '';
    expect(JSON.parse(gText).nodes.length).toBeGreaterThanOrEqual(1);

    // export produces a complete, portable bundle
    const exp = await client.callTool({ name: 'export', arguments: {} });
    expect(exp.isError).toBeFalsy();
    const eText = exp.content[0]?.type === 'text' ? exp.content[0].text : '';
    const bundle = JSON.parse(eText);
    expect(bundle.units.length).toBeGreaterThanOrEqual(1);
    expect(bundle.traces.length).toBeGreaterThanOrEqual(1);
  });

  it('routes assets to agents via list_equipped and call_asset', async () => {
    // Save a published workspace-visible skill and a draft asset.
    const save = await client.callTool({
      name: 'save_asset',
      arguments: {
        asset: {
          kind: 'skill',
          name: 'Deploy skill',
          description: 'How to deploy',
          content: '{"steps":[]}',
          body: 'Step one. Step two. Step three.',
          trigger: 'when deploying',
          tags: ['codex'],
          status: 'published',
          visibility: 'workspace',
          version: 1,
        },
      },
    });
    expect(save.isError).toBeFalsy();
    const saved = JSON.parse(save.content[0]?.type === 'text' ? save.content[0].text : '{}');
    expect(saved.id).toBeTruthy();

    const draft = await client.callTool({
      name: 'save_asset',
      arguments: {
        asset: {
          kind: 'skill',
          name: 'Draft skill',
          description: 'Not ready',
          content: '{"steps":[]}',
          body: 'Draft body',
          trigger: 'never',
          tags: [],
          sourceUnitIds: [],
          status: 'draft',
          visibility: 'private',
          boundAgents: ['codex'],
          version: 1,
        },
      },
    });
    expect(draft.isError).toBeFalsy();

    // Only the published, workspace-visible asset is equipped for the agent.
    const equipped = await client.callTool({
      name: 'list_equipped',
      arguments: { agent: 'codex' },
    });
    expect(equipped.isError).toBeFalsy();
    const eqText = equipped.content[0]?.type === 'text' ? equipped.content[0].text : '';
    const eq = JSON.parse(eqText);
    expect(Array.isArray(eq)).toBe(true);
    const names = eq.map((a: { name: string }) => a.name);
    expect(names).toContain('Deploy skill');
    expect(names).not.toContain('Draft skill');

    // call_asset returns the budget-gated body.
    const call = await client.callTool({
      name: 'call_asset',
      arguments: { id: saved.id, agent: 'codex', budget: 2 },
    });
    expect(call.isError).toBeFalsy();
    const callText = call.content[0]?.type === 'text' ? call.content[0].text : '';
    const callResult = JSON.parse(callText);
    expect(callResult.assetId).toBe(saved.id);
    expect(callResult.body).toContain('[truncated:');
  });
});

describe('AMEM_ZONE env scoping', () => {
  let envHandle: Awaited<ReturnType<typeof createMcpServer>>;
  let envClient: Client;
  let envStorage: Awaited<ReturnType<typeof createSqliteStorageFromPath>>;
  let opsZoneId: string;
  let researchZoneId: string;
  const envDir = mkdtempSync(join(tmpdir(), 'amem-mcp-envzone-'));
  const envDbPath = join(envDir, 'zone.db');
  const envConfig = mergeConfig({
    dbPath: envDbPath,
    embedding: { mode: 'offline', dims: 64 },
    jobs: { enabled: false },
  });
  const savedZoneEnv = process.env.AMEM_ZONE;

  const seedUnit = async (zoneId: string, title: string, body: string) => {
    const id = `seed-${zoneId}-${title}`.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
    await envStorage.createUnit({
      id,
      type: 'fact',
      form: 'unit',
      title,
      summary: title,
      body,
      tags: [],
      labels: {},
      status: 'reviewed',
      quality: 0.8,
      confidence: 0.9,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceCount: 1,
      importance: 0.5,
      decay: 0,
      version: 1,
      zoneId,
    });
  };

  beforeAll(async () => {
    envStorage = await createSqliteStorageFromPath(envDbPath);
    const ops = await envStorage.createZone({
      workspaceId: 'ws_personal',
      slug: 'ops',
      name: 'Ops',
      kind: 'project',
      visibility: 'workspace',
    });
    const research = await envStorage.createZone({
      workspaceId: 'ws_personal',
      slug: 'research',
      name: 'Research',
      kind: 'project',
      visibility: 'workspace',
    });
    opsZoneId = ops.id;
    researchZoneId = research.id;
    // A unit in the OTHER partition must stay invisible under AMEM_ZONE=ops.
    await seedUnit(
      researchZoneId,
      'Research-only deployment note',
      'This fact belongs to research, never ops.',
    );

    process.env.AMEM_ZONE = 'ops';
    envHandle = await createMcpServer(envConfig, { storage: envStorage });
    envClient = new Client({ name: 'amem-mcp-envzone-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await envHandle.server.connect(serverTransport);
    await envClient.connect(clientTransport);
  });

  afterAll(async () => {
    if (savedZoneEnv === undefined) delete process.env.AMEM_ZONE;
    else process.env.AMEM_ZONE = savedZoneEnv;
    await envClient?.close();
    await envHandle?.close();
    rmSync(envDir, { recursive: true, force: true });
  });

  it('save_unit without an explicit zone lands in the AMEM_ZONE partition', async () => {
    const save = await envClient.callTool({
      name: 'save_unit',
      arguments: {
        unit: {
          type: 'decision',
          form: 'unit',
          title: 'Ops env write',
          body: 'AMEM_ZONE must scope writes into the ops partition.',
        },
      },
    });
    expect(save.isError).toBeFalsy();
    const saved = JSON.parse(save.content[0]?.type === 'text' ? save.content[0].text : '{}');
    expect(saved.zoneId).toBe(opsZoneId);
  });

  it('read tools (get_graph / list_units / working_memory) are scoped to AMEM_ZONE', async () => {
    const graph = await envClient.callTool({ name: 'get_graph', arguments: {} });
    expect(graph.isError).toBeFalsy();
    const graphParsed = JSON.parse(graph.content[0]?.type === 'text' ? graph.content[0].text : '{}');
    const nodeTitles = (graphParsed.nodes ?? []).map((n: { title?: string }) => n.title ?? '');
    expect(nodeTitles.some((t: string) => t.includes('Ops env write'))).toBe(true);
    expect(nodeTitles.some((t: string) => t.includes('Research-only'))).toBe(false);

    const listed = await envClient.callTool({ name: 'list_units', arguments: {} });
    expect(listed.isError).toBeFalsy();
    const listedParsed = JSON.parse(
      listed.content[0]?.type === 'text' ? listed.content[0].text : '[]',
    );
    const listTitles = (listedParsed as Array<{ title: string }>).map((u) => u.title);
    expect(listTitles).toContain('Ops env write');
    expect(listTitles.some((t) => t.includes('Research-only'))).toBe(false);

    const wm = await envClient.callTool({ name: 'working_memory', arguments: {} });
    expect(wm.isError).toBeFalsy();
    const wmText = wm.content[0]?.type === 'text' ? wm.content[0].text : '';
    expect(wmText.includes('Research-only')).toBe(false);
  });

  it('recall restricted to AMEM_ZONE never leaks the other partition', async () => {
    const recall = await envClient.callTool({
      name: 'recall',
      arguments: { query: 'Research-only deployment note', tokenBudget: 800 },
    });
    expect(recall.isError).toBeFalsy();
    const rt = recall.content[0]?.type === 'text' ? recall.content[0].text : '';
    const parsed = JSON.parse(rt);
    expect(parsed.text.includes('Research-only')).toBe(false);
  });

  it('AMEM_ZONE pointing at a missing zone fails fast at startup', async () => {
    const old = process.env.AMEM_ZONE;
    process.env.AMEM_ZONE = 'does-not-exist';
    try {
      await expect(createMcpServer(envConfig, { storage: envStorage })).rejects.toThrow(
        /AMEM_ZONE/,
      );
    } finally {
      if (old === undefined) delete process.env.AMEM_ZONE;
      else process.env.AMEM_ZONE = old;
    }
  });
});
