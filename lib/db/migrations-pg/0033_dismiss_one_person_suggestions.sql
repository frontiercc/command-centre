-- A department suggestion needs at least two people.
-- Mining stopped proposing one-person jobs; this retires the ones already
-- open so every hub shows the same rule. Matched on the canvas JSON the mining
-- job writes (JSON.stringify, no spaces); a person can still add such a job by
-- hand as a use case. Only open rows change; nothing is deleted.
UPDATE use_case_suggestions
   SET status = 'dismissed', updated_at = extract(epoch from now())
 WHERE status = 'open'
   AND department IS NOT NULL
   AND canvas_json ~ '"people":1[,}]';
