import { InMemoryMembershipRepository } from './in-memory-membership.repository.js';
import { MembershipFacade } from './membership.facade.js';
import type { MembershipRepository } from './membership.repository.js';

export interface MembershipOverrides {
  repository?: MembershipRepository;
  newId?: () => string;
}

export function createMembershipFacade(overrides: MembershipOverrides = {}): MembershipFacade {
  const repository = overrides.repository ?? new InMemoryMembershipRepository();
  const newId = overrides.newId;
  return newId ? new MembershipFacade(repository, newId) : new MembershipFacade(repository);
}
