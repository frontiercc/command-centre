CREATE TABLE IF NOT EXISTS "coaching_acks" (
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "use_case_id" text NOT NULL REFERENCES "use_cases"("id") ON DELETE CASCADE,
  "acked_by" text NOT NULL,
  "acked_at" bigint NOT NULL,
  CONSTRAINT "coaching_acks_user_id_use_case_id_pk" PRIMARY KEY("user_id","use_case_id")
);
