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
import { redisPing, startWorkers } from './queues';

/** The worker has no API, but it still needs to be health-checked and scraped. */
function startOpsServer() {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
    } else if (req.url === '/health') {
      // Liveness: the process is up. It says nothing about whether it can do its work.
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok","service":"opspilot-worker"}');
    } else if (req.url === '/ready') {
      // Readiness: it can reach what it needs to take and finish a job.
      const [database, redis] = await Promise.all([prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false), redisPing()]);
      res.writeHead(database && redis ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: database && redis ? 'ready' : 'not_ready', service: 'opspilot-worker', database, redis }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(env.WORKER_PORT, () => logger.info({ port: env.WORKER_PORT }, 'worker health and metrics endpoint listening'));
  return server;
}

async function main() {
  const ops = startOpsServer();
  // Start-up can take a while (it waits for Redis). The signal handlers are in place before it
  // begins, so that a stop request during start-up is a clean exit and not a kill.
  const starting = startWorkers();
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal, graceMs: env.WORKER_SHUTDOWN_GRACE_MS }, 'worker shutting down');
    ops.close();
    const notYet = Symbol('still starting');
    const stop = await Promise.race([starting, new Promise<typeof notYet>((resolve) => setTimeout(() => resolve(notYet), 2000).unref())]).catch(() => notYet);
    // Running jobs get the grace period to finish. What is still running then is stopped and
    // recorded as interrupted, so nothing is left looking as if it were still in progress.
    // A worker that never finished starting has taken no job.
    if (stop !== notYet) await (stop as Awaited<typeof starting>)({ graceMs: env.WORKER_SHUTDOWN_GRACE_MS });
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await starting;
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
