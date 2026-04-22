import { randomUUID } from 'node:crypto';

import type { BookId, CatalogFacade } from '../catalog/index.js';
import type { MembershipFacade } from '../membership/index.js';
import type { EventBus } from '../shared/events/event-bus.js';
import { InMemoryEventBus } from '../shared/events/in-memory-event-bus.js';
import { InMemoryLoanRepository } from './in-memory-loan.repository.js';
import { InMemoryReservationRepository } from './in-memory-reservation.repository.js';
import { InMemoryTransactionalContext } from './in-memory-transactional-context.js';
import { LendingFacade } from './lending.facade.js';
import type { LoanRepository } from './loan.repository.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { TransactionalContextFactory } from './transactional-context.js';

export interface LendingOverrides {
  catalogFacade: CatalogFacade;
  membershipFacade: MembershipFacade;
  loanRepository?: LoanRepository;
  reservationRepository?: ReservationRepository;
  eventBus?: EventBus;
  txFactory?: TransactionalContextFactory;
  newId?: () => string;
  clock?: () => Date;
}

export function createLendingFacade(overrides: LendingOverrides): LendingFacade {
  const reservationRepository =
    overrides.reservationRepository ?? new InMemoryReservationRepository();
  const reservationView = {
    pendingReservationCountForBook: async (bookId: BookId) =>
      (await reservationRepository.listPendingReservationsForBook(bookId)).length,
  };
  const loanRepository = overrides.loanRepository ?? new InMemoryLoanRepository(reservationView);
  const eventBus = overrides.eventBus ?? new InMemoryEventBus();
  const txFactory = overrides.txFactory ?? (() => new InMemoryTransactionalContext(eventBus));
  const newId = overrides.newId ?? randomUUID;
  const clock = overrides.clock ?? (() => new Date());

  return new LendingFacade(
    overrides.catalogFacade,
    overrides.membershipFacade,
    loanRepository,
    reservationRepository,
    eventBus,
    txFactory,
    newId,
    clock,
  );
}
