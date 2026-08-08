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

  beforeAll(async () => {
    const storage = await createSqliteStorageFromPath(dbPath);
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
