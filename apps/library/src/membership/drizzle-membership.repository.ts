import { eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client.js';
import { members } from '../db/schema/index.js';
import type { MembershipRepository } from './membership.repository.js';
import {
  MembershipStatus,
  MembershipTier,
  type MemberDto,
  type MemberId,
} from './membership.types.js';

type MemberRow = typeof members.$inferSelect;

export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: AppDatabase) {}

  async saveMember(member: MemberDto): Promise<void> {
    await this.db
      .insert(members)
      .values(toRow(member))
      .onConflictDoUpdate({ target: members.memberId, set: toRow(member) });
  }

  async findMemberById(memberId: MemberId): Promise<MemberDto | undefined> {
    const [row] = await this.db.select().from(members).where(eq(members.memberId, memberId));
    return row ? toDto(row) : undefined;
  }

  async findMemberByEmail(email: string): Promise<MemberDto | undefined> {
    const [row] = await this.db.select().from(members).where(eq(members.email, email));
    return row ? toDto(row) : undefined;
  }
}

function toRow(member: MemberDto): MemberRow {
  return {
    memberId: member.memberId,
    name: member.name,
    email: member.email,
    tier: member.tier,
    status: member.status,
  };
}

function toDto(row: MemberRow): MemberDto {
  return {
    memberId: row.memberId,
    name: row.name,
    email: row.email,
    tier: row.tier as MembershipTier,
    status: row.status as MembershipStatus,
  };
}
