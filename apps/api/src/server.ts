import { DEV_APP_SECRET } from '@parlante/shared/node';
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

  if (config.APP_SECRET === DEV_APP_SECRET) {
    // Production refuses to start with it (parseEnv); anything else gets told, loudly.
    app.log.warn(
      'APP_SECRET is the public development default: file links can be forged and stored webhook secrets decrypted by anyone who has read the source. Set APP_SECRET (and NODE_ENV=production) before exposing this server.',
    );
  }
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info(
    `Parlante API ready on port ${config.API_PORT} — docs at ${config.PUBLIC_API_URL}/docs`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
