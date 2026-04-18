import type { MemberDto, MemberId } from './membership.types.js';

export interface MembershipRepository {
  saveMember(member: MemberDto): Promise<void>;
  findMemberById(memberId: MemberId): Promise<MemberDto | undefined>;
  findMemberByEmail(email: string): Promise<MemberDto | undefined>;
}
