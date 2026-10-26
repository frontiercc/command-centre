-- Seeds the four Anthropic marketplace connectors onto the S&C Board as
-- published Anthropic entries with a description and an install guide.
-- Without it, a new hub showed no card until the connector was used, and then
-- a bare one (no description, so no Install button).
--
-- Safe on every hub: a missing card is created; an existing card only gains a
-- description / install guide where that field is empty, or where it still
-- holds 044's own stale text. Anything an admin wrote is never overwritten,
-- and a same-named entry that is not a connector is left alone.
INSERT INTO skill_library_entries
  (name, type, surface, source, description, is_published, install_guide)
VALUES
  ('Gmail',        'connector', 'cowork', 'anthropic', 'Read, search and draft emails in Gmail directly from your Claude session.', 1,
   'Add it in Claude under Settings → Connectors. On a Team or Enterprise plan, an organisation owner may need to enable it first.'),
  ('Slack',        'connector', 'cowork', 'anthropic', 'Read channels, search messages, and send updates to Slack from Claude.', 1,
   'Add it in Claude under Settings → Connectors. On a Team or Enterprise plan, an organisation owner may need to enable it first.'),
  ('Salesforce',   'connector', 'cowork', 'anthropic', 'Query CRM records, update opportunities, and pull account data via SOQL.', 1,
   'Add it in Claude under Settings → Connectors. On a Team or Enterprise plan, an organisation owner may need to enable it first.'),
  ('Google Drive', 'connector', 'cowork', 'anthropic', 'Read, summarise, and reference Google Docs, Sheets, and Slides as context in your Claude session.', 1,
   'Add it in Claude under Settings → Connectors. On a Team or Enterprise plan, an organisation owner may need to enable it first.')
ON CONFLICT (name) DO UPDATE SET
  description = CASE
    WHEN COALESCE(skill_library_entries.description, '') = '' THEN EXCLUDED.description
    ELSE skill_library_entries.description END,
  install_guide = CASE
    WHEN COALESCE(skill_library_entries.install_guide, '') IN ('', 'Add via claude.ai → Integrations') THEN EXCLUDED.install_guide
    ELSE skill_library_entries.install_guide END
WHERE skill_library_entries.type = 'connector';
