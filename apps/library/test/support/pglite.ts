import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../../src/db/schema/index.js';

export type PgliteDb = PgliteDatabase<typeof schema>;

export interface PgliteFixture {
  db: PgliteDb;
  close(): Promise<void>;
}

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'db',
  'migrations',
);

export async function startPglite(): Promise<PgliteFixture> {
  const pglite = new PGlite();
  await applyMigrations(pglite);
  const db = drizzle(pglite, { schema });
  return {
    db,
    close: () => pglite.close(),
  };
}

async function applyMigrations(pglite: PGlite): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const statements = await readFile(join(migrationsDir, file), 'utf8');
    await pglite.exec(statements);
  }
}
