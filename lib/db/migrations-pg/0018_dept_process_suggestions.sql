ALTER TABLE use_case_suggestions ADD COLUMN department TEXT;
ALTER TABLE use_case_suggestions ADD COLUMN canvas_json TEXT;
CREATE INDEX idx_use_case_suggestions_department ON use_case_suggestions(department);
ALTER TABLE use_cases ADD COLUMN pain_point TEXT;
ALTER TABLE use_cases ADD COLUMN value_hypothesis TEXT;
ALTER TABLE use_cases ADD COLUMN baseline_note TEXT;
ALTER TABLE use_cases ADD COLUMN kpi_note TEXT;
