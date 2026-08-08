import { configFromEnv } from '@amem/core';
import { createServer } from './server.js';

async function main() {
  const config = configFromEnv();
  const { url, close } = await createServer(config, { listen: true });
  console.log(`Amem server listening at ${url}`);
  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
