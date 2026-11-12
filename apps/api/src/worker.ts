import './telemetry';
// Importing the feature modules registers their job processors.
import './modules/github';
import './modules/investigations';
import './modules/knowledge';
import './modules/system';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { startWorkers } from './queues';

async function main() {
  const stop = await startWorkers();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
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
