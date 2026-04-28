import type { MemberId } from '../membership/index.js';

export type Role = 'MEMBER' | 'ACCOUNT';

export interface AuthUser {
  memberId: MemberId;
  role: Role;
}

export type ModuleName = string;
export type ActionName = string;

export class UnauthorizedRoleError extends Error {
  constructor(
    public readonly memberId: MemberId,
    public readonly role: Role,
    public readonly moduleName: ModuleName,
    public readonly action: ActionName,
  ) {
    super(
      `role ${role} is not authorized to perform ${moduleName}.${action} (memberId: ${memberId})`,
    );
    this.name = 'UnauthorizedRoleError';
  }
}

export class UnknownActionError extends Error {
  constructor(
    public readonly moduleName: ModuleName,
    public readonly action: ActionName,
  ) {
    super(`unknown action ${moduleName}.${action} — no policy defined`);
    this.name = 'UnknownActionError';
  }
}
