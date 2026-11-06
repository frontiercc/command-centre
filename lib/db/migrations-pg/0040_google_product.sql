-- Claude in Google Sheets, Docs and Slides gets its own products
-- (sheets / docs / slides). The Google Workspace add-on sends the same spans as
-- Claude in Office, told apart only by agent.vendor ('g' Google, 'm' Microsoft).
-- Before this change the receiver ignored the vendor, so Google rows were
-- stored as excel / word / powerpoint.
--
-- Relabel the sessions that can be told apart after the fact: any session that
-- ran execute_apps_script. Apps Script is Google's alone (Microsoft's add-in
-- runs execute_office_js), so the whole session is Google. Tool names are in
-- content_preview on cowork_tool_metadata rows. A session with no Apps Script
-- call keeps its Microsoft label: its vendor was never stored, and the other
-- tool names (read_doc_section, for one) are shared by both add-ins.
-- Idempotent: a second run finds nothing left to change.
WITH google_sessions AS (
  SELECT DISTINCT session_id
  FROM cowork_messages
  WHERE message_type = 'cowork_tool_metadata'
    AND content_preview = 'execute_apps_script'
    AND product IN ('excel', 'word', 'powerpoint')
)
UPDATE cowork_messages m
SET product = CASE m.product WHEN 'excel' THEN 'sheets' WHEN 'word' THEN 'docs' WHEN 'powerpoint' THEN 'slides' END
FROM google_sessions g
WHERE m.session_id = g.session_id
  AND m.product IN ('excel', 'word', 'powerpoint');
--> statement-breakpoint
UPDATE cowork_sessions s
SET product = CASE s.product WHEN 'excel' THEN 'sheets' WHEN 'word' THEN 'docs' WHEN 'powerpoint' THEN 'slides' END
WHERE s.product IN ('excel', 'word', 'powerpoint')
  AND EXISTS (
    SELECT 1 FROM cowork_messages m
    WHERE m.session_id = s.id AND m.product IN ('sheets', 'docs', 'slides')
  );
