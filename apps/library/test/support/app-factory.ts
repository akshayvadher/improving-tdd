import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';

import { AppModule } from '../../src/app.module.js';
import { DomainErrorFilter } from '../../src/shared/http/domain-error.filter.js';

export interface TestAppOptions {
  databaseUrl: string;
}

export async function createTestApp(options: TestAppOptions): Promise<INestApplication> {
  process.env.DATABASE_URL = options.databaseUrl;
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
  return app;
}
