import { buildApp, API_VERSION } from './app.js';
import { createDbFromEnv, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { ProcessorRegistry, SandboxProcessor } from './processors/index.js';

/**
 * Process entrypoint. Kept thin on purpose: build deps, listen, shut down
 * cleanly. Anything that decides behaviour belongs in a module a test can
 * import without opening a socket.
 *
 * Migrations run on boot only when MIGRATE_ON_BOOT is set. Three replicas
 * racing to ALTER the same table is how an outage starts, so production
 * deploys run `npm run migrate` as a separate step.
 */

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const db: Db = await createDbFromEnv();

  if (process.env.MIGRATE_ON_BOOT === 'true') {
    const applied = await migrate(db);
    process.stdout.write(`migrations applied: ${applied.length}\n`);
  }

  const registry = new ProcessorRegistry();
  registry.register(new SandboxProcessor());

  const app = await buildApp({
    db,
    registry,
    apiVersion: API_VERSION,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  });

  let closing = false;
  const close = async (signal: string): Promise<void> => {
    // A second Ctrl-C during shutdown must not start a second teardown.
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    // Drain in-flight requests before closing the pool, or a deploy cuts off a
    // charge halfway through writing its response.
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  await app.listen({ port: PORT, host: HOST });
  process.stdout.write(`qq-payment-gateway ${API_VERSION} listening on ${HOST}:${PORT}\n`);
}

/** Prints configuration for the health log, with the connection string redacted. */
export function describeConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    port: env.PORT ?? '8080',
    host: env.HOST ?? '0.0.0.0',
    database: env.DATABASE_URL ? `postgres (${redactUrl(env.DATABASE_URL)})` : 'pglite',
    migrate_on_boot: env.MIGRATE_ON_BOOT === 'true' ? 'true' : 'false',
  };
}

/** postgres://user:secret@host/db -> postgres://user:***@host/db */
export function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, (_m, user: string) => `://${user}:***@`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});