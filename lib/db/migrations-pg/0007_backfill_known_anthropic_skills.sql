UPDATE skill_library_entries
SET source = 'anthropic', is_published = 1, updated_at = extract(epoch from now())
WHERE type = 'skill'
  AND name IN (
    'docx', 'xlsx', 'pptx', 'pdf',
    'brand-guidelines', 'consolidate-memory', 'doc-coauthoring', 'humanize',
    'internal-comms', 'meeting-notes', 'senior-pitch-writing', 'setup-cowork',
    'skill-creator', 'slack-gif-creator', 'theme-factory'
  );
