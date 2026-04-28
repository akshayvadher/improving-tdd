import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { AccessControlFacade, AccessControlModule } from '../access-control/index.js';
import { CatalogFacade, CatalogModule } from '../catalog/index.js';
import type { AppDatabase } from '../db/client.js';
import { DATABASE, DatabaseModule } from '../db/database.module.js';
import { MembershipFacade, MembershipModule } from '../membership/index.js';
import type { EventBus } from '../shared/events/event-bus.js';
import { InMemoryEventBus } from '../shared/events/in-memory-event-bus.js';
import {
  type AutoLoanOnReturnConsumer,
  createAutoLoanOnReturnConsumer,
} from './auto-loan-on-return.consumer.js';
import { DrizzleLoanRepository } from './drizzle-loan.repository.js';
import { DrizzleReservationRepository } from './drizzle-reservation.repository.js';
import { DrizzleTransactionalContext } from './drizzle-transactional-context.js';
import { LendingController } from './lending.controller.js';
import { LendingFacade } from './lending.facade.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { TransactionalContextFactory } from './transactional-context.js';

const LOAN_REPOSITORY = Symbol('LoanRepository');
const RESERVATION_REPOSITORY = Symbol('ReservationRepository');
const EVENT_BUS = Symbol('EventBus');
const TRANSACTIONAL_CONTEXT_FACTORY = Symbol('TransactionalContextFactory');
const AUTO_LOAN_CONSUMER = Symbol('AutoLoanOnReturnConsumer');

@Module({
  imports: [AccessControlModule, CatalogModule, MembershipModule, DatabaseModule],
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
        accessControl: AccessControlFacade,
        loans: DrizzleLoanRepository,
        reservations: DrizzleReservationRepository,
        bus: InMemoryEventBus,
        txFactory: () => DrizzleTransactionalContext,
      ) =>
        new LendingFacade(catalog, membership, accessControl, loans, reservations, bus, txFactory),
      inject: [
        CatalogFacade,
        MembershipFacade,
        AccessControlFacade,
        LOAN_REPOSITORY,
        RESERVATION_REPOSITORY,
        EVENT_BUS,
        TRANSACTIONAL_CONTEXT_FACTORY,
      ],
    },
    {
      provide: AUTO_LOAN_CONSUMER,
      useFactory: (
        bus: EventBus,
        membership: MembershipFacade,
        reservations: ReservationRepository,
        lending: LendingFacade,
        txFactory: TransactionalContextFactory,
      ) =>
        createAutoLoanOnReturnConsumer({
          bus,
          membership,
          reservations,
          lending,
          txFactory,
        }),
      inject: [
        EVENT_BUS,
        MembershipFacade,
        RESERVATION_REPOSITORY,
        LendingFacade,
        TRANSACTIONAL_CONTEXT_FACTORY,
      ],
    },
  ],
  exports: [LendingFacade, EVENT_BUS],
})
export class LendingModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(AUTO_LOAN_CONSUMER)
    private readonly autoLoanConsumer: AutoLoanOnReturnConsumer,
  ) {}

  onModuleInit(): void {
    this.autoLoanConsumer.start();
  }

  onModuleDestroy(): void {
    this.autoLoanConsumer.stop();
  }
}
