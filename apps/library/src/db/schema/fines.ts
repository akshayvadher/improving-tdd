import { integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

export const fines = pgTable('fines', {
  fineId: uuid('fine_id').primaryKey(),
  memberId: uuid('member_id').notNull(),
  loanId: uuid('loan_id').notNull(),
  amountCents: integer('amount_cents').notNull(),
  assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
});
