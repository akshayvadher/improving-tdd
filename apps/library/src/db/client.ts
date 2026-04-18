import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema/index.js';

export type AppDatabase = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  sql: Sql;
  close(): Promise<void>;
}

export function createDatabase(connectionUrl: string): DatabaseHandle {
  const sql = postgres(connectionUrl, { max: 10 });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}
