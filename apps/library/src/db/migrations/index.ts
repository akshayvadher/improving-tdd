import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Sql } from 'postgres';

const migrationsDir = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(sql: Sql): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();

  for (const file of files) {
    const statements = await readFile(join(migrationsDir, file), 'utf8');
    await sql.unsafe(statements);
  }
}

export { migrationsDir };
