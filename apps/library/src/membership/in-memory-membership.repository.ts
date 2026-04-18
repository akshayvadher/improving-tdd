import type { MembershipRepository } from './membership.repository.js';
import type { MemberDto, MemberId } from './membership.types.js';

export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly membersById = new Map<MemberId, MemberDto>();

  async saveMember(member: MemberDto): Promise<void> {
    this.membersById.set(member.memberId, member);
  }

  async findMemberById(memberId: MemberId): Promise<MemberDto | undefined> {
    return this.membersById.get(memberId);
  }

  async findMemberByEmail(email: string): Promise<MemberDto | undefined> {
    for (const member of this.membersById.values()) {
      if (member.email === email) {
        return member;
      }
    }
    return undefined;
  }
}
