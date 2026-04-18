import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { createDatabase, type AppDatabase, type DatabaseHandle } from './client.js';

export const DATABASE = Symbol('AppDatabase');
export const DATABASE_HANDLE = Symbol('AppDatabaseHandle');

@Injectable()
class DatabaseLifecycle implements OnModuleDestroy {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  onModuleDestroy(): Promise<void> {
    return this.handle.close();
  }
}

function resolveConnectionUrl(config: ConfigService): string {
  const url = config.get<string>('DATABASE_URL');
  if (!url) {
    throw new Error('DATABASE_URL is required to start the library app');
  }
  return url;
}

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [
    {
      provide: DATABASE_HANDLE,
      useFactory: (config: ConfigService): DatabaseHandle => createDatabase(resolveConnectionUrl(config)),
      inject: [ConfigService],
    },
    {
      provide: DATABASE,
      useFactory: (handle: DatabaseHandle): AppDatabase => handle.db,
      inject: [DATABASE_HANDLE],
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE, DATABASE_HANDLE],
})
export class DatabaseModule {}
