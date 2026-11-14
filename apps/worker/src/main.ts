import { createLogger, startWorker } from './bootstrap';
import { loadConfig } from './config';

/** Worker entry point: `pnpm --filter @parlante/worker dev` / `start`. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const worker = await startWorker(config, logger);
  logger.info(`Parlante worker ready — queues: ${worker.queues.join(', ') || '(none)'}`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    try {
      await worker.stop();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
