import { Injectable } from '@nestjs/common';

import {
  UnauthorizedRoleError,
  UnknownActionError,
  type ActionName,
  type AuthUser,
  type ModuleName,
} from './access-control.types.js';
import { POLICY } from './policy.js';

@Injectable()
export class AccessControlFacade {
  authorize(authUser: AuthUser, moduleName: ModuleName, action: ActionName): void {
    const allowedRoles = POLICY[moduleName]?.[action];
    if (!allowedRoles) {
      throw new UnknownActionError(moduleName, action);
    }
    if (!allowedRoles.includes(authUser.role)) {
      throw new UnauthorizedRoleError(authUser.memberId, authUser.role, moduleName, action);
    }
  }
}
