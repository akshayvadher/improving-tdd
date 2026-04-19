import { Module } from '@nestjs/common';

import type { AppDatabase } from '../db/client.js';
import { DATABASE, DatabaseModule } from '../db/database.module.js';
import { LendingFacade, LendingModule } from '../lending/index.js';
import { MembershipFacade, MembershipModule } from '../membership/index.js';
import { InMemoryEventBus } from '../shared/events/in-memory-event-bus.js';
import { DrizzleFineRepository } from './drizzle-fine.repository.js';
import type { FineRepository } from './fine.repository.js';
import { FinesController } from './fines.controller.js';
import { FinesFacade } from './fines.facade.js';
import type { FinesConfig } from './fines.types.js';
import { sampleFinesConfig } from './sample-fines-data.js';

const FINE_REPOSITORY = Symbol('FineRepository');
const FINES_EVENT_BUS = Symbol('FinesEventBus');
const FINES_CONFIG = Symbol('FinesConfig');

@Module({
  imports: [LendingModule, MembershipModule, DatabaseModule],
  controllers: [FinesController],
  providers: [
    {
      provide: FINE_REPOSITORY,
      useFactory: (db: AppDatabase) => new DrizzleFineRepository(db),
      inject: [DATABASE],
    },
    {
      provide: FINES_EVENT_BUS,
      useClass: InMemoryEventBus,
    },
    {
      provide: FINES_CONFIG,
      useValue: sampleFinesConfig(),
    },
    {
      provide: FinesFacade,
      useFactory: (
        lending: LendingFacade,
        membership: MembershipFacade,
        repository: FineRepository,
        bus: InMemoryEventBus,
        config: FinesConfig,
      ) => new FinesFacade(lending, membership, repository, bus, config),
      inject: [LendingFacade, MembershipFacade, FINE_REPOSITORY, FINES_EVENT_BUS, FINES_CONFIG],
    },
  ],
  exports: [FinesFacade],
})
export class FinesModule {}
