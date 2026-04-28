import { AccessControlFacade } from './access-control.facade.js';

export interface AccessControlOverrides {
  // No collaborators today — keep the slot in case a future override is needed.
}

export function createAccessControlFacade(
  _overrides: AccessControlOverrides = {},
): AccessControlFacade {
  return new AccessControlFacade();
}
