-- Team coaching (Developer Pulse): the actions a team lead marked done, one row per team and
-- action, with the figure the action is meant to move as it stood that day, for the team and for
-- the organisation, and the lead's note of what the team did. done_by is the admin session email
-- (an admin-domain address, not a monitored user). Permanent, like coaching_acks: no retention
-- window, removed only when the team's data is erased.
CREATE TABLE IF NOT EXISTS "coaching_actions" (
  "department" text NOT NULL,
  "action_key" text NOT NULL,
  "action_text" text NOT NULL,
  "metric" text,
  "baseline" double precision,
  "org_baseline" double precision,
  "note" text,
  "done_by" text NOT NULL,
  "done_at" bigint NOT NULL,
  CONSTRAINT "coaching_actions_department_action_key_pk" PRIMARY KEY("department","action_key")
);
