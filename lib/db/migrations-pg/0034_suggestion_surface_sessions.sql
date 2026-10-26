-- Department suggestions are mined from Claude Code
-- prompts as well as Cowork, and a department with both shows two boxes, so
-- each suggestion records where it was found ('cowork' | 'code'; NULL on rows
-- mined before this release, all of which came from Cowork). It also records
-- the sessions it was based on, so a new suggestion built mostly on the same
-- sessions as one a person dismissed or added is not suggested again.
ALTER TABLE use_case_suggestions ADD COLUMN IF NOT EXISTS surface text;
--> statement-breakpoint
ALTER TABLE use_case_suggestions ADD COLUMN IF NOT EXISTS cited_sessions text;
