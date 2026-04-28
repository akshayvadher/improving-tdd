export { AccessControlFacade } from './access-control.facade.js';
export { AccessControlModule } from './access-control.module.js';
export {
  UnauthorizedRoleError,
  UnknownActionError,
  type ActionName,
  type AuthUser,
  type ModuleName,
  type Role,
} from './access-control.types.js';
export { lookupAuthUser, resetRolesForDemo, setRoleForDemo } from './auth-context.js';
