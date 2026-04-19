CREATE TABLE IF NOT EXISTS "fines" (
  "fine_id" uuid PRIMARY KEY NOT NULL,
  "member_id" uuid NOT NULL,
  "loan_id" uuid NOT NULL,
  "amount_cents" integer NOT NULL,
  "assessed_at" timestamptz NOT NULL,
  "paid_at" timestamptz
);
