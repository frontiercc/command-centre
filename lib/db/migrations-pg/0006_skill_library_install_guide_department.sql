ALTER TABLE skill_library_entries RENAME COLUMN install_hint TO install_guide;
ALTER TABLE skill_library_entries ADD COLUMN department TEXT;
CREATE INDEX IF NOT EXISTS idx_skill_library_entries_department ON skill_library_entries(department);
