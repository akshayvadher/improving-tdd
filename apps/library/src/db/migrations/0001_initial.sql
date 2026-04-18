CREATE TABLE "books" (
  "book_id" uuid PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "authors" text[] NOT NULL,
  "isbn" text NOT NULL UNIQUE
);

CREATE TABLE "members" (
  "member_id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "tier" text NOT NULL,
  "status" text NOT NULL
);

CREATE TABLE "copies" (
  "copy_id" uuid PRIMARY KEY NOT NULL,
  "book_id" uuid NOT NULL REFERENCES "books"("book_id"),
  "condition" text NOT NULL,
  "status" text NOT NULL
);

CREATE TABLE "loans" (
  "loan_id" uuid PRIMARY KEY NOT NULL,
  "member_id" uuid NOT NULL REFERENCES "members"("member_id"),
  "copy_id" uuid NOT NULL REFERENCES "copies"("copy_id"),
  "book_id" uuid NOT NULL REFERENCES "books"("book_id"),
  "borrowed_at" timestamptz NOT NULL,
  "due_date" timestamptz NOT NULL,
  "returned_at" timestamptz
);

CREATE TABLE "reservations" (
  "reservation_id" uuid PRIMARY KEY NOT NULL,
  "member_id" uuid NOT NULL REFERENCES "members"("member_id"),
  "book_id" uuid NOT NULL REFERENCES "books"("book_id"),
  "reserved_at" timestamptz NOT NULL,
  "fulfilled_at" timestamptz
);
