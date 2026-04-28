import type { BookId } from '../../catalog/index.js';
import { createCatalogFacade } from '../../catalog/catalog.configuration.js';
import { sampleNewBook, sampleNewCopy } from '../../catalog/sample-catalog-data.js';
import type { LoanDto } from '../../lending/index.js';
import { createLendingFacade } from '../../lending/lending.configuration.js';
import type { MembershipFacade } from '../../membership/index.js';
import { createMembershipFacade } from '../../membership/membership.configuration.js';
import { sampleNewMember } from '../../membership/sample-membership-data.js';
import { InMemoryEventBus } from '../../shared/events/in-memory-event-bus.js';
import { createFinesFacade } from '../fines.configuration.js';
import type { FineAssessed, FinesConfig, MemberAutoSuspended } from '../fines.types.js';
import { InMemoryFineRepository } from '../in-memory-fine.repository.js';
import { sampleFinesConfig } from '../sample-fines-data.js';

// Frozen "assessment" clock. Every overdue calculation in these specs is
// performed relative to FIXED_NOW so day-count math stays trivial.
export const FIXED_NOW = new Date('2030-01-15T00:00:00Z');
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Lending computes `dueDate = borrowedAt + 14 days`. To produce a loan that
// is `daysOverdue` days past due at FIXED_NOW, we borrow with Lending's clock
// pointed at `FIXED_NOW - (14 + daysOverdue) days`. The scene keeps a mutable
// "borrow clock" so separate loans can have separate overdue amounts.
export const LOAN_DURATION_DAYS = 14;

export function sequentialIds(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

// --- Scene builder ----------------------------------------------------------
// Per AC-2.6 we use the REAL Catalog + Membership + Lending facades, wired
// with their own in-memory defaults via their factories. No hand-rolled fakes.
//
// The optional `membership` override exists for exactly one purpose: the
// single justified hand-rolled fake in `fines.suspend-throws.spec.ts`. When
// absent (the default for every other spec), a real factory-wired
// MembershipFacade is used.

export interface Scene {
  fines: ReturnType<typeof createFinesFacade>;
  catalog: ReturnType<typeof createCatalogFacade>;
  membership: MembershipFacade;
  lending: ReturnType<typeof createLendingFacade>;
  repository: InMemoryFineRepository;
  bus: InMemoryEventBus;
  seedMember(name?: string): Promise<{ memberId: string }>;
  seedAvailableCopy(): Promise<{ copyId: string; bookId: BookId }>;
  seedOverdueLoanFor(memberId: string, daysOverdue: number): Promise<LoanDto>;
}

export interface SceneOverrides {
  config?: FinesConfig;
  membership?: MembershipFacade;
}

export function buildScene(overrides: SceneOverrides = {}): Scene {
  const catalog = createCatalogFacade({ newId: sequentialIds('cat') });
  const membership =
    overrides.membership ?? createMembershipFacade({ newId: sequentialIds('mem') });
  const bus = new InMemoryEventBus();
  const repository = new InMemoryFineRepository();

  // The Lending facade needs a clock so we can rewind it before each borrow
  // to produce deterministically overdue loans. The mutable ref below is the
  // only reason we are not just passing `fixedClock` — Fines assesses at
  // FIXED_NOW, but Lending's borrow side must appear to have happened in the
  // past for the resulting loan to be overdue.
  let borrowClock = new Date(FIXED_NOW.getTime());
  const lending = createLendingFacade({
    catalogFacade: catalog,
    membershipFacade: membership,
    newId: sequentialIds('loan'),
    clock: () => new Date(borrowClock.getTime()),
  });

  const fines = createFinesFacade({
    lendingFacade: lending,
    membershipFacade: membership,
    repository,
    eventBus: bus,
    config: overrides.config ?? sampleFinesConfig(),
    newId: sequentialIds('fine'),
    clock: () => new Date(FIXED_NOW.getTime()),
  });

  // Unique ISBN / email per seeded artefact so real uniqueness rules are
  // satisfied across successive seed calls inside one scene.
  let copySeq = 0;
  let memberSeq = 0;

  return {
    fines,
    catalog,
    membership,
    lending,
    repository,
    bus,
    async seedMember(name = 'Member') {
      memberSeq += 1;
      const member = await membership.registerMember(
        sampleNewMember({ name, email: `member-${memberSeq}@lib.test` }),
      );
      return { memberId: member.memberId };
    },
    async seedAvailableCopy() {
      copySeq += 1;
      const isbn = `978-${String(copySeq).padStart(10, '0')}`;
      const book = await catalog.addBook(sampleNewBook({ isbn }));
      const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));
      return { copyId: copy.copyId, bookId: copy.bookId };
    },
    async seedOverdueLoanFor(memberId: string, daysOverdue: number) {
      const copy = await (async () => {
        copySeq += 1;
        const isbn = `978-${String(copySeq).padStart(10, '0')}`;
        const book = await catalog.addBook(sampleNewBook({ isbn }));
        return catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));
      })();
      borrowClock = new Date(FIXED_NOW.getTime() - (LOAN_DURATION_DAYS + daysOverdue) * MS_PER_DAY);
      return lending.borrow({ memberId, role: 'MEMBER' }, copy.copyId);
    },
  };
}

export function assessedEvents(bus: InMemoryEventBus): FineAssessed[] {
  return bus.collected().filter((event): event is FineAssessed => event.type === 'FineAssessed');
}

export function autoSuspendedEvents(bus: InMemoryEventBus): MemberAutoSuspended[] {
  return bus
    .collected()
    .filter((event): event is MemberAutoSuspended => event.type === 'MemberAutoSuspended');
}
