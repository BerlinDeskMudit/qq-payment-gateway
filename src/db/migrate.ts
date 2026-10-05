import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDbFromEnv, type Db } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

/**
 * Migrations are plain SQL applied in filename order, each in its own
 * transaction. Each file is expected to contain its own BEGIN/COMMIT, which
 * we strip before wrapping so we control the transaction boundary.
 */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const raw = await readFile(join(migrationsDir, file), 'utf8');
    const sql = raw.replace(/^\s*BEGIN\s*;/im, '').replace(/\bCOMMIT\s*;?\s*$/im, '');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}

/**
 * True when this file is the process entrypoint. Built with pathToFileURL
 * rather than string concatenation: on Windows import.meta.url is
 * file:///C:/... and a hand-built 'file://' + path yields file://C:/...,
 * which never matches and silently disables the CLI.
 */
export function isEntrypoint(metaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  return metaUrl === pathToFileURL(argv1).href;
}

if (isEntrypoint(import.meta.url)) {
  const db = await createDbFromEnv();
  const ran = await migrate(db);
  if (ran.length === 0) console.log('schema up to date');
  else for (const f of ran) console.log(`applied ${f}`);
  await db.close();
}
