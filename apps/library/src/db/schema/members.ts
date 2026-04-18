import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const members = pgTable('members', {
  memberId: uuid('member_id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  tier: text('tier').notNull(),
  status: text('status').notNull(),
});
