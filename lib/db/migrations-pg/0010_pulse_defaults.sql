-- Seeds both flags on. On a fresh database both keys were otherwise absent
-- from config, and the scheduler's old strict `=== 'true'` check treated
-- "absent" as "permanently disabled". ON CONFLICT DO NOTHING: never overwrites
-- a value an admin already set deliberately.
INSERT INTO config (key, value) VALUES ('pulse_enabled', 'true') ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES ('code_pulse_enabled', 'true') ON CONFLICT (key) DO NOTHING;
