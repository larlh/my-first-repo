import { buildApp } from './app';
import { loadConfig } from './config';

/** API entry point: `pnpm --filter @parlante/api dev` / `start`. */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info(
    `Parlante API ready on port ${config.API_PORT} — docs at ${config.PUBLIC_API_URL}/docs`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
