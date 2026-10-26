-- Session descriptions gained a repair attempt and stopped rejecting replies for
-- quotation marks. Give every session still without a description a fresh set of
-- attempts, so the ones refused under the old check are tried again. Rows that
-- hold a description are untouched. Safe to run more than once.
UPDATE cowork_session_descriptions SET attempts = 0 WHERE description IS NULL;
