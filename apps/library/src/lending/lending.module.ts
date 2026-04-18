import { Module } from '@nestjs/common';

import { CatalogFacade, CatalogModule } from '../catalog/index.js';
import { DATABASE, DatabaseModule } from '../db/database.module.js';
import type { AppDatabase } from '../db/client.js';
import { MembershipFacade, MembershipModule } from '../membership/index.js';
import { InMemoryEventBus } from '../shared/events/in-memory-event-bus.js';
import { DrizzleLoanRepository } from './drizzle-loan.repository.js';
import { DrizzleReservationRepository } from './drizzle-reservation.repository.js';
import { DrizzleTransactionalContext } from './drizzle-transactional-context.js';
import { LendingController } from './lending.controller.js';
import { LendingFacade } from './lending.facade.js';

const LOAN_REPOSITORY = Symbol('LoanRepository');
const RESERVATION_REPOSITORY = Symbol('ReservationRepository');
const EVENT_BUS = Symbol('EventBus');
const TRANSACTIONAL_CONTEXT_FACTORY = Symbol('TransactionalContextFactory');

@Module({
  imports: [CatalogModule, MembershipModule, DatabaseModule],
  controllers: [LendingController],
  providers: [
    {
      provide: LOAN_REPOSITORY,
      useFactory: (db: AppDatabase) => new DrizzleLoanRepository(db),
      inject: [DATABASE],
    },
    {
      provide: RESERVATION_REPOSITORY,
      useFactory: (db: AppDatabase) => new DrizzleReservationRepository(db),
      inject: [DATABASE],
    },
    {
      provide: EVENT_BUS,
      useClass: InMemoryEventBus,
    },
    {
      provide: TRANSACTIONAL_CONTEXT_FACTORY,
      useFactory: (db: AppDatabase, bus: InMemoryEventBus) => () =>
        new DrizzleTransactionalContext(db, bus),
      inject: [DATABASE, EVENT_BUS],
    },
    {
      provide: LendingFacade,
      useFactory: (
        catalog: CatalogFacade,
        membership: MembershipFacade,
        loans: DrizzleLoanRepository,
        reservations: DrizzleReservationRepository,
        bus: InMemoryEventBus,
        txFactory: () => DrizzleTransactionalContext,
      ) => new LendingFacade(catalog, membership, loans, reservations, bus, txFactory),
      inject: [
        CatalogFacade,
        MembershipFacade,
        LOAN_REPOSITORY,
        RESERVATION_REPOSITORY,
        EVENT_BUS,
        TRANSACTIONAL_CONTEXT_FACTORY,
      ],
    },
  ],
  exports: [LendingFacade, EVENT_BUS],
})
export class LendingModule {}
