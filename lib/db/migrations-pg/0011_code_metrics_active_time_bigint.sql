-- code_metrics.active_time_user_s / active_time_cli_s were `integer` (int4, max
-- ~2.1B) but are populated by SUMming raw OTel data points — a corrupted or
-- duplicated client-side metric can overflow that ceiling (a production
-- incident: active_time_cli_s summed to ~6.1B in a single 7-day rolling window,
-- crashing the insert on every scheduler cycle). Widen to bigint; existing rows
-- are well within range so this is a pure type widen, no data change.
ALTER TABLE code_metrics ALTER COLUMN active_time_user_s TYPE bigint;
ALTER TABLE code_metrics ALTER COLUMN active_time_cli_s TYPE bigint;
