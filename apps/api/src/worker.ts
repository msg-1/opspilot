import './telemetry';
// Importing the feature modules registers their job processors.
import './modules/github';
import './modules/investigations';
import './modules/knowledge';
import './modules/system';
import { createServer } from 'node:http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { registry } from './lib/metrics';
import { prisma } from './lib/prisma';
import { startWorkers } from './queues';

/** The worker has no API, but it still needs to be health-checked and scraped. */
function startOpsServer() {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
    } else if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok","service":"opspilot-worker"}');
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(env.WORKER_PORT, () => logger.info({ port: env.WORKER_PORT }, 'worker health and metrics endpoint listening'));
  return server;
}

async function main() {
  const ops = startOpsServer();
  const stop = await startWorkers();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    ops.close();
    await stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
