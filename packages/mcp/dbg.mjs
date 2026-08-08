import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig } from '@amem/core';
import { createSqliteStorageFromPath } from '@amem/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './dist/server.js';

const dir = mkdtempSync(join(tmpdir(), 'amem-dbg-'));
const dbPath = join(dir, 't.db');
const config = mergeConfig({ dbPath, embedding: { mode: 'offline', dims: 64 }, jobs: { enabled: false } });
const storage = await createSqliteStorageFromPath(dbPath);
const serverHandle = await createMcpServer(config, { storage });
const client = new Client({ name: 'dbg', version: '1' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await serverHandle.server.connect(st);
await client.connect(ct);

const save = await client.callTool({ name: 'save_asset', arguments: { asset: { kind: 'skill', name: 'Deploy skill', description: 'd', content: '{}', body: 'Step one.', trigger: 'when deploying', tags: ['codex'], sourceUnitIds: [], status: 'published', visibility: 'workspace', version: 1 } } });
console.log('save isError:', save.isError);
if (save.isError) console.log(JSON.stringify(save.content, null, 2));
const eq = await client.callTool({ name: 'list_equipped', arguments: { agent: 'codex' } });
console.log('eq isError:', eq.isError);
if (eq.isError) console.log(JSON.stringify(eq.content, null, 2));
await client.close(); await serverHandle.close(); rmSync(dir, { recursive: true, force: true });
