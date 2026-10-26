-- A stored report records whether
-- it holds a section only admins and managers may read (FinOps "Cost &
-- Chargeback", Spend Review: named per-person spend), so the Reports list and
-- report reads can hide it from viewers. Reports stored before this release
-- carry no record and are marked by their section headings.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS manager_only integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE reports SET manager_only = 1
 WHERE content_md LIKE '%## Cost & Chargeback%' OR content_md LIKE '%### Spend Review:%';
