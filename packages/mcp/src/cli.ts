#!/usr/bin/env node
import { configFromEnv } from '@amem/core';
import type { AmemConfig } from '@amem/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from './server.js';

export async function runStdio(config: AmemConfig = configFromEnv()): Promise<void> {
  const { server, close } = await createMcpServer(config);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    try {
      await transport.close();
    } catch {
      // ignore transport close errors during shutdown
    }
    await close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await server.connect(transport);
}

// Run directly only when invoked as the CLI entry point (resolves symlinked bins).
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === self;
  } catch {
    return process.argv[1] === self;
  }
}

if (isMainModule()) void runStdio();
