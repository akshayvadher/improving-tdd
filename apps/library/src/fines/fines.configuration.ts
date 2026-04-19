import { randomUUID } from 'node:crypto';

import type { LendingFacade } from '../lending/index.js';
import type { MembershipFacade } from '../membership/index.js';
import type { EventBus } from '../shared/events/event-bus.js';
import { InMemoryEventBus } from '../shared/events/in-memory-event-bus.js';
import type { FineRepository } from './fine.repository.js';
import { FinesFacade } from './fines.facade.js';
import type { FinesConfig } from './fines.types.js';
import { InMemoryFineRepository } from './in-memory-fine.repository.js';
import { sampleFinesConfig } from './sample-fines-data.js';

export interface FinesOverrides {
  lendingFacade: LendingFacade;
  membershipFacade: MembershipFacade;
  repository?: FineRepository;
  eventBus?: EventBus;
  config?: FinesConfig;
  newId?: () => string;
  clock?: () => Date;
}

export function createFinesFacade(overrides: FinesOverrides): FinesFacade {
  const repository = overrides.repository ?? new InMemoryFineRepository();
  const eventBus = overrides.eventBus ?? new InMemoryEventBus();
  const config = overrides.config ?? sampleFinesConfig();
  const newId = overrides.newId ?? randomUUID;
  const clock = overrides.clock ?? (() => new Date());

  return new FinesFacade(
    overrides.lendingFacade,
    overrides.membershipFacade,
    repository,
    eventBus,
    config,
    newId,
    clock,
  );
}
