import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export interface RedisFixture {
  url: string;
  stop(): Promise<void>;
}

// Starts a pinned Redis 7 container and returns the connection URL plus a stop
// hook for afterAll. Mirrors `startPostgres()` shape: GenericContainer + log-based
// wait (Podman-friendly), 120s startup timeout, single exposed port.
export async function startRedis(): Promise<RedisFixture> {
  const container: StartedTestContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(120_000)
    .start();

  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;

  return {
    url,
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}
