import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['src/**/*.spec.ts'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['test/**/*.integration.spec.ts'],
      environment: 'node',
      testTimeout: 60_000,
      hookTimeout: 180_000,
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'pglite',
      include: ['test/**/*.pglite.spec.ts'],
      environment: 'node',
      testTimeout: 60_000,
      hookTimeout: 180_000,
    },
  },
]);
