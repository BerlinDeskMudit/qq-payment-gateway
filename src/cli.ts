import { createDbFromEnv } from './db/index.js';
import { migrate, isEntrypoint } from './db/migrate.js';
import { createApiKey } from './auth/apiKey.js';
import { newId, randomSecret } from './lib/ids.js';

/**
 * Operator CLI. The first-run path a new merchant actually uses:
 *
 *   npm run cli -- onboard --name "Acme" --email ops@acme.test --country US
 *
 * Prints the secret key exactly once. There is no endpoint that can retrieve
 * it later, because we store only a hash; that is a deliberate trade of
 * convenience for not being able to leak a credential we hold.
 */

type ArgMap = Record<string, string>;

function parseArgs(argv: string[]): { command: string; args: ArgMap } {
  const [command = 'help', ...rest] = argv;
  const args: ArgMap = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return { command, args };
}

const HELP = `qq-payment-gateway cli

  onboard   --name <name> --email <email> --country <ISO2> [--region <region>]
            Creates an account, its first admin API key and a webhook endpoint.
  migrate   Applies pending migrations.
  help      This message.

The API key is printed once and cannot be recovered.`;

export async function runCli(argv: string[]): Promise<number> {
  const { command, args } = parseArgs(argv);

  if (command === 'help' || args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const db = await createDbFromEnv();

  try {
    if (command === 'migrate') {
      const applied = await migrate(db);
      process.stdout.write(`applied: ${applied.join(', ') || 'none'}\n`);
      return 0;
    }

    if (command === 'onboard') {
      const name = args.name;
      const email = args.email;
      const country = (args.country ?? 'US').toUpperCase();
      if (!name || !email) {
        process.stderr.write('onboard requires --name and --email\n');
        return 2;
      }

      // Onboarding is the first thing an operator runs against a fresh
      // database, so it applies migrations itself. `migrate` is idempotent, and
      // failing here with "relation accounts does not exist" would be a
      // miserable first impression of the product.
      const applied = await migrate(db);

      const accountId = newId('acct', 22);
      await db.query(
        `INSERT INTO accounts (id, name, email, country, region, livemode)
         VALUES ($1, $2, $3, $4, $5, false)`,
        [accountId, name, email, country, args.region ?? 'us'],
      );

      const key = await createApiKey(db, { accountId, role: 'owner', livemode: false });

      let webhook: { id: string; secret: string } | null = null;
      if (args.webhook_url) {
        webhook = { id: newId('we', 22), secret: randomSecret(32) };
        await db.query(
          `INSERT INTO webhook_endpoints (id, account_id, url, secret, description)
           VALUES ($1, $2, $3, $4, $5)`,
          [webhook.id, accountId, args.webhook_url, webhook.secret, 'created by cli onboard'],
        );
      }

      process.stdout.write(
        [
          ...(applied.length ? [`migrations    ${applied.join(', ')}`] : []),
          `account_id     ${accountId}`,
          `region         ${args.region ?? 'us'}`,
          `api_key        ${key.rawKey}`,
          webhook ? `webhook_id     ${webhook.id}` : null,
          webhook ? `webhook_secret ${webhook.secret}` : null,
          '',
          'The API key and webhook secret are shown once. Store them now.',
          '',
        ]
          .filter((l) => l !== null)
          .join('\n'),
      );
      return 0;
    }

    process.stderr.write(`unknown command '${command}'\n\n${HELP}\n`);
    return 2;
  } finally {
    await db.close();
  }
}

if (isEntrypoint(import.meta.url)) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}

export { HELP };