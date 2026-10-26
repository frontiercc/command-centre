// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Every scheduled job, in the order the scheduler runs them, with the label an
 * admin reads on the System health panel. The names are the runJob() names in lib/ingestion/scheduler.ts;
 * test/scheduler-job-coverage.test.ts fails when the two lists disagree, so a
 * new job cannot be missing from the panel.
 *
 * Client-safe: no server imports.
 */
export interface JobCatalogEntry {
  name: string;
  label: string;
  /**
   * Runs daily or less often. One failure raises an alert, because the next
   * attempt may be a day or a week away; frequent jobs alert after two in a
   * row, so a single transient error stays quiet.
   */
  infrequent?: true;
}

export const JOB_CATALOG: readonly JobCatalogEntry[] = [
  { name: 'compliance_sync', label: 'Compliance sync' },
  { name: 'analytics_ingest', label: 'Analytics ingest', infrequent: true },
  { name: 'retention_cleanup', label: 'Retention cleanup', infrequent: true },
  { name: 'user_cleanup', label: 'User cleanup', infrequent: true },
  { name: 'session_cleanup', label: 'Session cleanup', infrequent: true },
  { name: 'pulse_classifier', label: 'Cowork classifier' },
  { name: 'pulse_hourly_aggregation', label: 'Work Pulse hourly aggregation' },
  { name: 'cowork_session_aggregation', label: 'Cowork session statistics' },
  { name: 'pulse_session_descriptions', label: 'Cowork session descriptions' },
  { name: 'classifier_audit_draw', label: 'Classifier audit draw', infrequent: true },
  { name: 'code_hourly_aggregation', label: 'Developer Pulse aggregation' },
  { name: 'use_case_tracker', label: 'Use case tracker' },
  { name: 'use_case_session_judge', label: 'Use case session judging', infrequent: true },
  { name: 'process_mining', label: 'Department process mining', infrequent: true },
  { name: 'finance_drift_alert', label: 'FinOps reconciliation-drift alert' },
  { name: 'code_classifier', label: 'Code classifier' },
  { name: 'code_weekly_briefing', label: 'Developer Pulse weekly briefing', infrequent: true },
  { name: 'github_sync', label: 'GitHub sync', infrequent: true },
  { name: 'pulse_daily_aggregation', label: 'Work Pulse daily aggregation', infrequent: true },
  { name: 'pulse_weekly_briefing', label: 'Work Pulse weekly briefing', infrequent: true },
  { name: 'pulse_cio_briefing', label: 'Executive briefing', infrequent: true },
  { name: 'weekly_digest', label: 'Weekly digest' },
  { name: 'system_health_alerts', label: 'System health alerts' },
  { name: 'alerts_slack_sweep', label: 'High-priority alerts to Slack' },
  { name: 'skills_discover', label: 'Skills discovery', infrequent: true },
];

export function jobLabel(name: string): string {
  return JOB_CATALOG.find(j => j.name === name)?.label ?? name;
}
