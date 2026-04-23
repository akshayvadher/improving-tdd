import { beforeEach, describe, expect, it } from 'vitest';

import { CopyStatus, type CatalogFacade, type CopyDto, type CopyId } from '../catalog/index.js';
import type { EligibilityDto, MemberId, MembershipFacade } from '../membership/index.js';
import { InMemoryEventBus } from '../shared/events/in-memory-event-bus.js';
import { InMemoryReservationRepository } from './in-memory-reservation.repository.js';
import { createLendingFacade } from './lending.configuration.js';
import type { LendingFacade } from './lending.facade.js';
import { queueBuilder, type ReservationDsl } from './testing/reservation-dsl.js';

// Principle 11 ("show, don't tell"): the DSL lets each test read like a
// whiteboard sketch of the reservation queue, not a poke at internal state.

function sequentialIds(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

const FIXED_BORROW = new Date('2030-01-15T00:00:00Z');

// --- Minimal hand-written fakes for OTHER modules' facades (principle 7). -----

interface FakeCatalog {
  seedCopy(copy: CopyDto): void;
  findCopy(copyId: CopyId): CopyDto;
  markCopyAvailable(copyId: CopyId): CopyDto;
  markCopyUnavailable(copyId: CopyId): CopyDto;
}

function fakeCatalogFacade(): FakeCatalog {
  const copies = new Map<CopyId, CopyDto>();
  const requireCopy = (copyId: CopyId): CopyDto => {
    const copy = copies.get(copyId);
    if (!copy) {
      throw new Error(`fake catalog has no copy: ${copyId}`);
    }
    return copy;
  };
  return {
    seedCopy(copy) {
      copies.set(copy.copyId, { ...copy });
    },
    findCopy(copyId) {
      return requireCopy(copyId);
    },
    markCopyAvailable(copyId) {
      const updated: CopyDto = { ...requireCopy(copyId), status: CopyStatus.AVAILABLE };
      copies.set(copyId, updated);
      return updated;
    },
    markCopyUnavailable(copyId) {
      const updated: CopyDto = { ...requireCopy(copyId), status: CopyStatus.UNAVAILABLE };
      copies.set(copyId, updated);
      return updated;
    },
  };
}

function alwaysEligibleMembership(): Pick<MembershipFacade, 'checkEligibility'> {
  return {
    async checkEligibility(memberId: MemberId): Promise<EligibilityDto> {
      return { memberId, eligible: true };
    },
  };
}

// --- DSL scene builder --------------------------------------------------------

// Each scenario advances an internal clock on every reservation so that
// `listPendingReservationsForBook` sorts stably by reservedAt. Members reserve
// in DSL-call order and that is the order the queue reports.
interface DslScene {
  dsl: ReservationDsl;
  facade: LendingFacade;
  catalog: FakeCatalog;
  seedAvailableCopy(bookId: string): CopyDto;
}

function buildDslScene(): DslScene {
  const catalog = fakeCatalogFacade();
  const membership = alwaysEligibleMembership();
  const bus = new InMemoryEventBus();
  const reservations = new InMemoryReservationRepository();

  let tick = 0;
  const advancingClock = (): Date => {
    tick += 1;
    return new Date(FIXED_BORROW.getTime() + tick);
  };

  const facade = createLendingFacade({
    catalogFacade: catalog as unknown as CatalogFacade,
    membershipFacade: membership as unknown as MembershipFacade,
    reservationRepository: reservations,
    eventBus: bus,
    newId: sequentialIds('res'),
    clock: advancingClock,
  });

  const dsl = queueBuilder({ lending: facade, reservations });

  let copySeq = 0;
  return {
    dsl,
    facade,
    catalog,
    seedAvailableCopy(bookId) {
      copySeq += 1;
      const copy: CopyDto = {
        copyId: `copy-${copySeq}`,
        bookId,
        condition: 'GOOD',
        status: CopyStatus.AVAILABLE,
      };
      catalog.seedCopy(copy);
      return copy;
    },
  };
}

describe('reservation queue DSL', () => {
  let scene: DslScene;

  beforeEach(() => {
    scene = buildDslScene();
  });

  it('orders the queue by reservation order — alice, bob, carol', async () => {
    // given a book three members want
    const book = 'the-pragmatic-programmer';
    const { dsl } = scene;

    // when each member reserves it in order
    await dsl.after('alice').reserves(book);
    await dsl.after('bob').reserves(book);
    await dsl.after('carol').reserves(book);

    // then the queue for that book lists them in the order they joined
    expect(await dsl.queueFor(book)).toEqual(['alice', 'bob', 'carol']);
  });

  it("leaves the queue untouched on return — queue walking is the consumer's job", async () => {
    // given alice has borrowed a copy and two other members are waiting in line
    const book = 'refactoring';
    const copy = scene.seedAvailableCopy(book);
    const aliceLoan = await scene.facade.borrow('alice', copy.copyId);
    const { dsl } = scene;
    await dsl.after('bob').reserves(book);
    await dsl.after('carol').reserves(book);

    // sanity check: the queue reflects bob ahead of carol
    expect(await dsl.queueFor(book)).toEqual(['bob', 'carol']);

    // when alice returns the book with no consumer wired
    await dsl.whenReturned(aliceLoan.loanId);

    // then the queue is unchanged — returnLoan no longer fulfils reservations.
    // The AutoLoanOnReturnConsumer owns queue-walking now (covered by its own
    // spec), and this DSL scene does not spin one up.
    expect(await dsl.queueFor(book)).toEqual(['bob', 'carol']);
  });
});
