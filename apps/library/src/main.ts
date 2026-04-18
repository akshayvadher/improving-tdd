import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { runMigrations } from './db/migrations/index.js';
import { DATABASE_HANDLE } from './db/database.module.js';
import type { DatabaseHandle } from './db/client.js';
import { DomainErrorFilter } from './shared/http/domain-error.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const handle = app.get<DatabaseHandle>(DATABASE_HANDLE);
  await runMigrations(handle.sql);
  app.useGlobalFilters(new DomainErrorFilter());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

bootstrap();
