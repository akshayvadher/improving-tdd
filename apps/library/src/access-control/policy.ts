import type { Role } from './access-control.types.js';

// Data-driven RBAC policy. Each entry says: for this (module, action), these roles are allowed.
// Add new entries here as new gated actions ship; the AccessControlFacade reads this map and never
// hardcodes role logic in business code.
export const POLICY: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<Role>>>>> = {
  lending: {
    borrow: ['MEMBER'],
  },
};
