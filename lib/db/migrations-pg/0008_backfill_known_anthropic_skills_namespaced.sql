UPDATE skill_library_entries
SET source = 'anthropic', is_published = 1, updated_at = extract(epoch from now())
WHERE type = 'skill'
  AND name IN (
    'anthropic-skills:docx', 'anthropic-skills:xlsx', 'anthropic-skills:pptx', 'anthropic-skills:pdf',
    'anthropic-skills:brand-guidelines', 'anthropic-skills:consolidate-memory',
    'anthropic-skills:doc-coauthoring', 'anthropic-skills:humanize',
    'anthropic-skills:internal-comms', 'anthropic-skills:meeting-notes',
    'anthropic-skills:senior-pitch-writing', 'anthropic-skills:setup-cowork',
    'anthropic-skills:skill-creator', 'anthropic-skills:slack-gif-creator',
    'anthropic-skills:theme-factory'
  );
