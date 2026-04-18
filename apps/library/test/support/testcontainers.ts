import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';

import { runMigrations } from '../../src/db/migrations/index.js';

export interface PostgresFixture {
  connectionUrl: string;
  stop(): Promise<void>;
}

// Starts a pinned Postgres 16 container, applies the SQL migrations once, and
// returns the connection URL plus a stop hook for afterAll.
//
// Uses GenericContainer + log-based wait instead of `@testcontainers/postgresql`
// because the latter's pg_isready exec-based wait strategy hangs on Podman's
// Windows named pipe (dockerode stdio-attach over npipe is unreliable).
// The log-based wait is equivalent in practice — Postgres writes
// "database system is ready to accept connections" once per startup.
export async function startPostgres(): Promise<PostgresFixture> {
  const database = 'library_test';
  const username = 'library';
  const password = 'library';

  const container: StartedTestContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB: database,
      POSTGRES_USER: username,
      POSTGRES_PASSWORD: password,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionUrl = `postgresql://${username}:${password}@${host}:${port}/${database}`;

  await applyMigrations(connectionUrl);

  return {
    connectionUrl,
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}

async function applyMigrations(connectionUrl: string): Promise<void> {
  const migrator = postgres(connectionUrl, { max: 1 });
  try {
    await runMigrations(migrator);
  } finally {
    await migrator.end({ timeout: 5 });
  }
}
