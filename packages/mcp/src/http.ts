import type { AmemConfig } from '@amem/core';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';

export interface HttpServerHandle {
  server: HttpServer;
  close(): Promise<void>;
}

export const DEFAULT_HTTP_TRANSPORT_PORT = 8322;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startHttpServer(
  config: AmemConfig,
  port?: number,
): Promise<HttpServerHandle> {
  const { server: mcp, close: closeMcp } = await createMcpServer(config);
  const transport = new StreamableHTTPServerTransport();
  await mcp.connect(transport);

  const host = config.host;
  const httpPort =
    port ??
    Number(process.env.AMEM_HTTP_TRANSPORT_PORT ?? config.port ?? DEFAULT_HTTP_TRANSPORT_PORT);

  const httpServer: HttpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': config.corsOrigin ?? '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
            'Access-Control-Expose-Headers': 'Mcp-Session-Id',
          });
          res.end();
          return;
        }

        if (req.method === 'GET' || req.method === 'POST') {
          const body = req.method === 'POST' ? await readBody(req) : undefined;
          const parsedBody = body ? (JSON.parse(body) as unknown) : undefined;
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    },
  );

  await new Promise<void>((resolve) => httpServer.listen(httpPort, host, resolve));

  return {
    server: httpServer,
    async close() {
      await transport.close();
      await closeMcp();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
