-- Team coaching now covers Work Pulse as well as Developer Pulse, so a done action has to say
-- which surface it belongs to: the same department has a plan on both, and the action keys
-- overlap ('hardly_used' means one thing about Claude Code and another about Cowork). Existing
-- rows are Developer Pulse, which is the only surface that has written any.
ALTER TABLE "coaching_actions" ADD COLUMN IF NOT EXISTS "surface" text NOT NULL DEFAULT 'code';

ALTER TABLE "coaching_actions" DROP CONSTRAINT IF EXISTS "coaching_actions_department_action_key_pk";
ALTER TABLE "coaching_actions" DROP CONSTRAINT IF EXISTS "coaching_actions_surface_department_action_key_pk";
ALTER TABLE "coaching_actions"
  ADD CONSTRAINT "coaching_actions_surface_department_action_key_pk"
  PRIMARY KEY ("surface", "department", "action_key");
