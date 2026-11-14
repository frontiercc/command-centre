-- So what (Developer Pulse): the decisions a leader took on the page, with every figure that was
-- on the card the day they took it, so the follow-up can say what happened since without being
-- able to move the goalposts. One row per card and team: deciding again replaces the row only by
-- undoing it first. decided_by is the admin session email (an admin-domain address, not a
-- monitored user). Permanent, like coaching_actions: no retention window.
CREATE TABLE IF NOT EXISTS "decision_log" (
  "card" text NOT NULL,
  "department" text NOT NULL,
  -- What the page recommended, and what the leader actually chose: the two can differ, and an
  -- override is as much a decision as agreeing.
  "recommended" text NOT NULL,
  "chosen" text NOT NULL,
  "headline" text NOT NULL,
  -- The card's figures as they stood, as JSON, so the follow-up compares like with like.
  "figures_json" text NOT NULL,
  "note" text,
  "decided_by" text NOT NULL,
  "decided_at" bigint NOT NULL,
  -- When the card comes back to say what happened.
  "look_again_at" bigint NOT NULL,
  CONSTRAINT "decision_log_card_department_pk" PRIMARY KEY("card","department")
);
