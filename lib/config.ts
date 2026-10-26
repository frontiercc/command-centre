// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Applies the blessed query pattern (see
// lib/db/error-queries.ts / lib/db/admin-queries.ts for worked examples): getTypedClient() + schema.config, onConflictDoUpdate
// for the upsert, withTx for the multi-row saveConfig write, app-clock
// timestamps.
//
// Secrets: config.value is plain TEXT (never jsonb — no Policy A columns
// here). SENSITIVE_KEYS are ENCRYPTED AT REST:
// every write goes through storeValue(), which
// encrypts with CCC_ENCRYPTION_KEY (AES-256-GCM, `enc:` prefix), and every
// read goes through readSecret(). encryptStoredSecrets() converts any
// remaining plaintext rows at boot. The key lives in each hub's Secrets
// Manager secret and the boot fetch refuses to change it.
import { BRIEFING_DEFAULT_MODEL, CLAUDE_MODEL } from './anthropic/constants';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getTypedClient } from './db/client';
import { schema } from './db/schema';
import { withTx } from './db/with-tx';
import { decryptSecret, encryptSecret, isEncrypted } from './auth/secrets';

export interface AppConfig {
  anthropicAdminApiKey: string;
  anthropicAnalyticsApiKey: string;
  anthropicAiApiKey: string;
  otelEndpointSecret: string;
  ingestIntervalSeconds: number;
  organisationName: string;
  acceptableUsePolicy: string;
  complianceLastCursor: string;
  analyticsLastDate: string;
  retentionCoworkDays: number;
  retentionOtelDays: number;
  retentionComplianceDays: number;
  retentionChatDays: number;
  retentionMode: 'strip' | 'purge';
  retentionLastRun: string;
  retentionLastResult: string;
  sessionCleanupLastRun: string;
  anomalyDetectionLastRun: string;
  retentionErrorDays: number;
  retentionCodeDays: number;
  retentionAlertsDays: number;
  retentionAnalyticsDays: number;
  archiveEnabled: boolean;
  archiveProvider: string;
  archiveBucket: string;
  archiveRegion: string;
  archiveAccessKeyId: string;
  archiveSecretAccessKey: string;
  // Compliance declarations
  dpiaCompleted: boolean;
  dpiaDate: string;
  dataProtectionOfficer: string;
  // LGPD declarations + framework applicability (Brazil)
  gdprApplicable: boolean;
  lgpdApplicable: boolean;
  dataProtectionEncarregado: string;
  ripdCompleted: boolean;
  ripdDate: string;
  aiActRiskTier: string;
  aiActTransparencyNotice: boolean;
  isoControlOwner: string;
  isoCertificationStatus: string;
  iso42001Owner: string;
  iso42001AssessmentStatus: string;
  // Risk scoring thresholds
  riskTokenMultiplier: number;
  riskFileAccessLimit: number;
  riskInactivityDays: number;
  riskSensitivity: 'conservative' | 'balanced' | 'aggressive';
  riskAlertAnomalyEnabled: boolean;
  riskAlertPolicyEnabled: boolean;
  riskAlertAdoptionEnabled: boolean;
  riskAlertRiskEnabled: boolean;
  riskAlertPulseCapabilityEnabled: boolean;
  // Spec item 9: the two previously-uncontrollable alert generators
  // (use-case at-risk lifecycle nudge, finance reconciliation drift) — kept
  // as the raw 'true'/'false' string (not coerced to boolean here) since the
  // generators read them directly via getConfigValue().
  riskAlertFinanceDriftEnabled: string;
  riskAlertUseCaseEnabled: string;
  riskSeverityLowDesc: string;
  riskSeverityMediumDesc: string;
  riskSeverityHighDesc: string;
  riskSeverityCriticalDesc: string;
  // Email / SMTP (password reset)
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
  smtpFromAddress: string;
  smtpFromName: string;
  // Work Pulse
  pulseEnabled: boolean;
  pulseClassifierModel: string;
  pulseBriefingModel: string;
  pulseUserBriefingModel: string;
  // 'false' stops the one-sentence session descriptions on the frontier boxes
  // (the only Work Pulse feature that sends prompt text to the model outside
  // the classifier). Default 'true'.
  pulseSessionDescriptionsEnabled: string;
  // Human time vs Claude time. 'true' turns on the by-hand
  // estimate for Tier 2/3 sessions and shows the cards. Default 'false'.
  humanTimeEnabled: string;
  // Code's own human-time switch (Admin → Developer Pulse). '' = follow humanTimeEnabled.
  humanTimeCodeEnabled: string;
  // 'true' raises an alert (and so a Slack message, if Slack alerts are on) for
  // system health problems, once per failure. Off by default: System health on
  // /admin/system shows them regardless.
  systemHealthAlertsEnabled: string;
  // Telemetry-silence alert (lib/alerts/telemetry-silence.ts), behind
  // systemHealthAlertsEnabled: working hours with nothing received before an
  // alert (default '3', '0' = off), the hub's time zone (default
  // 'Europe/London') and its working day as 'HH-HH' (default '08-18').
  telemetrySilenceHours: string;
  telemetrySilenceTimezone: string;
  telemetrySilenceWorkHours: string;
  // Dashboard "Get started" panel (lib/setup/status.ts). 'true' hides it; set
  // by an admin's Hide.
  setupGuideHidden: string;
  // 'true' once an admin marks the tiers as reviewed without changing them
  // (the tiers page can only save a change).
  setupRubricReviewed: string;
  // Get started steps an admin marked as done by hand: a JSON array of step ids.
  setupStepsDone: string;
  // Written by the OTel ingest route the first time real Claude Code or Cowork
  // telemetry arrives (epoch seconds). Never by sample data. Not admin-editable.
  setupFirstCodeAt: string;
  setupFirstCoworkAt: string;
  // Sessions needing both figures before a ratio ("about 7x faster") is shown. Default '20'.
  humanTimeMinSessionsForRatio: string;
  // Core AI model — the four original AI consumers (Intelligence Briefing,
  // anomaly detection, governance Reports, intent AI-assessment). Default Haiku.
  coreAiModel: string;
  // OTI v2: interpretation thresholds JSON {"progress":1.2,"uplift":1.5}, provisional.
  otiThresholds: string;
  // Dept benchmark: absolute DDS floor below which a department is flagged "needs support" (provisional).
  ddsSupportFloor: string;
  pulseClassifierLastRun: string;
  pulseAuditLastRun: string;
  pulseSessionDescriptionsLastRun: string;
  pulseAggregatorLastRun: string;
  pulseAggregatorDailyLastRun: string;
  // Job-written only (lib/pulse/cowork/session-aggregator.ts's runCoworkSessionAggJob,
  // hourly, cadence-guarded inside the job) — deliberately NOT in
  // app/api/config/route.ts's allowedKeys, same convention as the other *LastRun keys.
  coworkSessionAggLastRun: string;
  pulseWeeklyBriefingLastRun: string;
  pulseCioBriefingLastRun: string;
  pulseClassifierConfig: string;
  // Developer Pulse
  codePulseEnabled: boolean;
  codeModelRates: string;
  codeAggregatorLastRun: string;
  // Developer Pulse alerts (deterministic, evaluated hourly)
  codeAlertCostSpikeEnabled: boolean;
  codeCostSpikeMultiplier: number;
  codeCostSpikeFloorUsd: number;
  codeAlertModelPolicyEnabled: boolean;
  codeModelAllowlist: string;
  codeAlertRepoExposureEnabled: boolean;
  codeSensitiveRepoPatterns: string;
  codeAlertFrictionEnabled: boolean;
  codeFrictionThreshold: number;
  // Developer Pulse session-digest classifier (opt-in judged layer)
  codeClassifierEnabled: boolean;
  codeClassifierModel: string;
  codeClassifierIncludePrompt: boolean;
  codeClassifierLastRun: string;
  codeClassifierConfig: string;
  codeBriefingModel: string;
  // Developer Pulse Value (estimate) calibration
  codeValueEnabled: boolean;
  codeValueLiftPct: string;
  codeValueLoadedComp: string;
  codeValueCodingHrs: string;
  codeValueTeamSize: string;
  codeValueAnnualSpend: string;
  // Developer Pulse Time Saved (bottom-up estimate) — minutes-per-task assumptions
  timeSavedMinPerPr: string;
  timeSavedMinPerCommit: string;
  timeSavedMinPerCoworkSession: string;
  timeSavedMinPerChatConversation: string;
  // GitHub overlay (repo/org level only — standing decision)
  githubToken: string;
  githubSyncLastRun: string;
  codeBriefingLastRun: string;
  // OTel user lifecycle cleanup
  otelUserStaleDays: number;
  otelUserCleanupEnabled: boolean;
  userCleanupLastRun: string;
  // File upload alert patterns
  fileUploadAlertPatterns: string;
  // OTel excluded emails (JSON array of email strings)
  otelExcludedEmails: string;
  // Weekly Exec Digest
  digestEnabled: boolean;
  digestSlackWebhookUrl: string;
  digestRecipients: string;
  digestSendHourUtc: number;
  digestHubUrl: string;
  digestLastSentWeek: string;
  // High-Priority Alerts -> Slack
  alertsSlackEnabled: boolean;
  alertsSlackWebhookUrl: string;
  alertsSlackSweepLastRun: string;
  alertsSlackSweepCursor: string;
  // Licensed seats (dashboard Active Users denominator)
  licensedSeats: string;
  // OIDC SSO
  ssoEnabled: boolean;
  ssoIssuerUrl: string;
  ssoClientId: string;
  ssoClientSecret: string;
  ssoProviderLabel: string;
  ssoRedirectBaseUrl: string;
  // Use Cases register (Phase 1)
  useCasesEnabled: boolean;
  useCasesExtractModel: string;
  useCasesIdeateModel: string;
  // Cost & Chargeback (dormant)
  chargebackEnabled: boolean;
  financeModelEfficiencyEnabled: boolean;
  // Wasted-seats estimate (Workflow Impact) — price per licensed seat, USD/month.
  finopsSeatPriceMonthly: string;
  // Dev Framework Alignment (dormant)
  dxFrameworkEnabled: boolean;
  dxFrameworkMock: string;
  dxApiKey: string;
  dxInstanceUrl: string;
  // The collector address shown on Admin → Ingestion and in the copied Claude
  // settings. Blank = CCC_COLLECTOR_ADDRESS, then http://localhost:4318.
  otelCollectorAddress: string;
  // Content-informed emergent suggestions toggle (Phase 2.5). Default flipped to
  // 'true' by Department Process Transformation — on by default; also
  // governs whether the department process-mining boxes can exist at all.
  useCasesSuggestUseContent: string;
  // Commodity denylist (JSON string array) — signal VALUES excluded from emergent clustering
  // regardless of kind (skill/connector/task_type), matched case-insensitively.
  useCasesSuggestExcludedSignals: string;
  // Governance rollup (Phase 3) — value estimate calibration.
  useCasesMinutesSavedPerSession: string;
  useCasesLoadedCompAnnual: string;
  // Department Process Transformation — department-level content-mining
  // job (lib/usecases/process-mining.ts), scheduler cadence/thresholds/model.
  processMiningIntervalDays: string;
  processMiningWindowDays: string;
  processMiningMinUsers: string;
  processMiningMaxOpenPerDept: string;
  processMiningModel: string;
  // Tool-shaped denylist (JSON string array) — generic activity/tool-signal
  // titles rejected before storage; '' falls back to a code-defined default list.
  processMiningDenylist: string;
  // Job-written last-run stamp — internal only, never exposed via /api/config.
  processMiningLastRun: string;
  // "Turn this into a skill" readiness bar. PROPOSED
  // defaults, not yet measured against a live department — admin-editable on
  // /admin/use-cases so the first real drafts can recalibrate them.
  skillDraftMinPeople: string;
  skillDraftMinPrompts: string;
  skillDraftMinDays: string;
  skillDraftMinFollowUps: string;
  skillDraftSoloMinDays: string;
  skillDraftSoloMinWeeks: string;
  /** Model for "Turn this into a skill" drafts — this capability only; default Sonnet 5. */
  skillDraftModel: string;
  useCaseJudgeModel: string;
  useCaseJudgeLastRun: string;
  // Use Cases tracking (Phase 2) — internal only, never exposed via /api/config
  useCasesTrackerCursors: string;
  useCasesTrackerLastRun: string;
  // Admin-editable cadence knob; registered here so the
  // scheduler job's read/write round-trips through a real config column.
  useCasesTrackerIntervalHours: string;
  // Use Cases lifecycle thresholds (Phase 2) — admin-editable, read by lib/usecases/lifecycle.ts
  useCasesAdoptedMinWeeks: string;
  useCasesAdoptedMinUsers: string;
  useCasesAtRiskQuietWeeks: string;
  useCasesNotSeenQuietWeeks: string;
  // FinOps v2
  financeInsightModel: string;
  financeDriftAlertThresholdPct: string;
  financeEnterpriseMock: string;
  // Compliance API (Enterprise)
  complianceAccessKey: string;          // sk-ant-api01-..., SENSITIVE
  complianceSyncIntervalMinutes: string; // default '2'
  complianceBackfillDays: string;        // default '30'
  complianceChatsPerRun: string;         // default '200'
  complianceChatCursor: string;          // job-written
  complianceActivityCursor: string;      // job-written — ABANDONED (was a desc-cursor; see complianceActivityCursorAsc)
  complianceActivityCursorAsc: string;   // job-written — asc-walk cursor (replaces complianceActivityCursor)
  complianceActivityBackfillDays: string; // default '7' — bounded first-run backfill window for the asc activity walk
  // The Activity Feed sync default was
  // flooding the audit log with CCC's own polling (`compliance_api_accessed`,
  // 126/260 rows in a sample) — it's OFF by default now, and when an
  // admin turns it on, self-noise types are still excluded at ingest.
  complianceActivitySyncEnabled: boolean;      // default false — activity feed is dormant until an admin opts in
  complianceActivityExcludedTypes: string;     // default '["compliance_api_accessed"]' — JSON array of activity `type` values skipped at ingest
  complianceLastSyncAt: string;          // job-written (epoch seconds)
  complianceLastSyncStats: string;       // job-written (JSON)
  // Weekly Highlights (dormant) — model used by lib/highlights/compose.ts's
  // single LLM call. Registered here so compose.ts type-checks.
  highlightsModel: string;
  // Weekly Highlights (dormant) — minimally registered here so the
  // admin routes' getConfigValue() calls type-check.
  highlightsEnabled: string;
  highlightsIncludeNames: string;
  // Classifier drain helper (lib/pulse/drain.ts) — max passes per scheduled run.
  classifierDrainMaxPasses: number;
}

export const CONFIG_KEYS: Record<keyof AppConfig, string> = {
  anthropicAdminApiKey: 'anthropic_admin_api_key',
  anthropicAnalyticsApiKey: 'anthropic_analytics_api_key',
  anthropicAiApiKey: 'anthropic_ai_api_key',
  otelEndpointSecret: 'otel_endpoint_secret',
  ingestIntervalSeconds: 'ingest_interval_seconds',
  organisationName: 'organisation_name',
  acceptableUsePolicy: 'acceptable_use_policy',
  complianceLastCursor: 'compliance_last_cursor',
  analyticsLastDate: 'analytics_last_date',
  retentionCoworkDays: 'retention_cowork_days',
  retentionOtelDays: 'retention_otel_days',
  retentionComplianceDays: 'retention_compliance_days',
  retentionChatDays: 'retention_chat_days',
  retentionMode: 'retention_mode',
  retentionLastRun: 'retention_last_run',
  retentionLastResult: 'retention_last_result',
  sessionCleanupLastRun: 'session_cleanup_last_run',
  anomalyDetectionLastRun: 'anomaly_detection_last_run',
  retentionErrorDays: 'retention_error_days',
  retentionCodeDays: 'retention_code_days',
  retentionAlertsDays: 'retention_alerts_days',
  retentionAnalyticsDays: 'retention_analytics_days',
  archiveEnabled: 'archive_enabled',
  archiveProvider: 'archive_provider',
  archiveBucket: 'archive_bucket',
  archiveRegion: 'archive_region',
  archiveAccessKeyId: 'archive_access_key_id',
  archiveSecretAccessKey: 'archive_secret_access_key',
  dpiaCompleted: 'dpia_completed',
  dpiaDate: 'dpia_date',
  dataProtectionOfficer: 'data_protection_officer',
  gdprApplicable: 'gdpr_applicable',
  lgpdApplicable: 'lgpd_applicable',
  dataProtectionEncarregado: 'data_protection_encarregado',
  ripdCompleted: 'ripd_completed',
  ripdDate: 'ripd_date',
  aiActRiskTier: 'ai_act_risk_tier',
  aiActTransparencyNotice: 'ai_act_transparency_notice',
  isoControlOwner: 'iso_control_owner',
  isoCertificationStatus: 'iso_certification_status',
  iso42001Owner: 'iso_42001_owner',
  iso42001AssessmentStatus: 'iso_42001_assessment_status',
  riskTokenMultiplier: 'risk_token_multiplier',
  riskFileAccessLimit: 'risk_file_access_limit',
  riskInactivityDays: 'risk_inactivity_days',
  riskSensitivity: 'risk_sensitivity',
  riskAlertAnomalyEnabled: 'risk_alert_anomaly_enabled',
  riskAlertPolicyEnabled: 'risk_alert_policy_enabled',
  riskAlertAdoptionEnabled: 'risk_alert_adoption_enabled',
  riskAlertRiskEnabled: 'risk_alert_risk_enabled',
  riskAlertPulseCapabilityEnabled: 'risk_alert_pulse_capability_enabled',
  riskAlertFinanceDriftEnabled: 'risk_alert_finance_drift_enabled',
  riskAlertUseCaseEnabled: 'risk_alert_use_case_enabled',
  riskSeverityLowDesc: 'risk_severity_low_desc',
  riskSeverityMediumDesc: 'risk_severity_medium_desc',
  riskSeverityHighDesc: 'risk_severity_high_desc',
  riskSeverityCriticalDesc: 'risk_severity_critical_desc',
  smtpHost: 'smtp_host',
  smtpPort: 'smtp_port',
  smtpUser: 'smtp_user',
  smtpPassword: 'smtp_password',
  smtpFromAddress: 'smtp_from_address',
  smtpFromName: 'smtp_from_name',
  // Work Pulse
  pulseEnabled: 'pulse_enabled',
  pulseClassifierModel: 'pulse_classifier_model',
  pulseBriefingModel: 'pulse_briefing_model',
  pulseUserBriefingModel: 'pulse_user_briefing_model',
  pulseSessionDescriptionsEnabled: 'pulse_session_descriptions_enabled',
  humanTimeEnabled: 'human_time_enabled',
  humanTimeCodeEnabled: 'human_time_code_enabled',
  systemHealthAlertsEnabled: 'system_health_alerts_enabled',
  telemetrySilenceHours: 'telemetry_silence_hours',
  telemetrySilenceTimezone: 'telemetry_silence_timezone',
  telemetrySilenceWorkHours: 'telemetry_silence_work_hours',
  setupGuideHidden: 'setup_guide_hidden',
  setupRubricReviewed: 'setup_rubric_reviewed',
  setupStepsDone: 'setup_steps_done',
  setupFirstCodeAt: 'setup_first_code_at',
  setupFirstCoworkAt: 'setup_first_cowork_at',
  humanTimeMinSessionsForRatio: 'human_time_min_sessions_for_ratio',
  coreAiModel: 'core_ai_model',
  otiThresholds: 'oti_thresholds',
  ddsSupportFloor: 'dds_support_floor',
  pulseClassifierLastRun: 'pulse_classifier_last_run',
  pulseAuditLastRun: 'pulse_audit_last_run',
  pulseSessionDescriptionsLastRun: 'pulse_session_descriptions_last_run',
  pulseAggregatorLastRun: 'pulse_aggregator_last_run',
  pulseAggregatorDailyLastRun: 'pulse_aggregator_daily_last_run',
  coworkSessionAggLastRun: 'cowork_session_agg_last_run',
  pulseWeeklyBriefingLastRun: 'pulse_weekly_briefing_last_run',
  pulseCioBriefingLastRun: 'pulse_cio_briefing_last_run',
  pulseClassifierConfig: 'pulse_classifier_config',
  codePulseEnabled: 'code_pulse_enabled',
  codeModelRates: 'code_model_rates',
  codeAggregatorLastRun: 'code_aggregator_last_run',
  codeAlertCostSpikeEnabled: 'code_alert_cost_spike_enabled',
  codeCostSpikeMultiplier: 'code_cost_spike_multiplier',
  codeCostSpikeFloorUsd: 'code_cost_spike_floor_usd',
  codeAlertModelPolicyEnabled: 'code_alert_model_policy_enabled',
  codeModelAllowlist: 'code_model_allowlist',
  codeAlertRepoExposureEnabled: 'code_alert_repo_exposure_enabled',
  codeSensitiveRepoPatterns: 'code_sensitive_repo_patterns',
  codeAlertFrictionEnabled: 'code_alert_friction_enabled',
  codeFrictionThreshold: 'code_friction_threshold',
  codeClassifierEnabled: 'code_classifier_enabled',
  codeClassifierModel: 'code_classifier_model',
  codeClassifierIncludePrompt: 'code_classifier_include_prompt',
  codeClassifierLastRun: 'code_classifier_last_run',
  codeClassifierConfig: 'code_classifier_config',
  codeBriefingModel: 'code_briefing_model',
  codeValueEnabled: 'code_value_enabled',
  codeValueLiftPct: 'code_value_lift_pct',
  codeValueLoadedComp: 'code_value_loaded_comp',
  codeValueCodingHrs: 'code_value_coding_hrs',
  codeValueTeamSize: 'code_value_team_size',
  codeValueAnnualSpend: 'code_value_annual_spend',
  timeSavedMinPerPr: 'time_saved_min_per_pr',
  timeSavedMinPerCommit: 'time_saved_min_per_commit',
  timeSavedMinPerCoworkSession: 'time_saved_min_per_cowork_session',
  timeSavedMinPerChatConversation: 'time_saved_min_per_chat_conversation',
  githubToken: 'github_token',
  githubSyncLastRun: 'github_sync_last_run',
  codeBriefingLastRun: 'code_briefing_last_run',
  otelUserStaleDays: 'otel_user_stale_days',
  otelUserCleanupEnabled: 'otel_user_cleanup_enabled',
  userCleanupLastRun: 'user_cleanup_last_run',
  fileUploadAlertPatterns: 'file_upload_alert_patterns',
  otelExcludedEmails: 'otel_excluded_emails',
  digestEnabled: 'digest_enabled',
  digestSlackWebhookUrl: 'digest_slack_webhook_url',
  digestRecipients: 'digest_recipients',
  digestSendHourUtc: 'digest_send_hour_utc',
  digestHubUrl: 'digest_hub_url',
  digestLastSentWeek: 'digest_last_sent_week',
  alertsSlackEnabled: 'alerts_slack_enabled',
  alertsSlackWebhookUrl: 'alerts_slack_webhook_url',
  alertsSlackSweepLastRun: 'alerts_slack_sweep_last_run',
  alertsSlackSweepCursor: 'alerts_slack_sweep_cursor',
  licensedSeats: 'licensed_seats',
  ssoEnabled: 'sso_enabled',
  ssoIssuerUrl: 'sso_issuer_url',
  ssoClientId: 'sso_client_id',
  ssoClientSecret: 'sso_client_secret',
  ssoProviderLabel: 'sso_provider_label',
  ssoRedirectBaseUrl: 'sso_redirect_base_url',
  useCasesEnabled: 'use_cases_enabled',
  useCasesExtractModel: 'use_cases_extract_model',
  useCasesIdeateModel: 'use_cases_ideate_model',
  chargebackEnabled: 'chargeback_enabled',
  financeModelEfficiencyEnabled: 'finance_model_efficiency_enabled',
  finopsSeatPriceMonthly: 'finops_seat_price_monthly',
  dxFrameworkEnabled: 'dx_framework_enabled',
  dxFrameworkMock: 'dx_framework_mock',
  dxApiKey: 'dx_api_key',
  dxInstanceUrl: 'dx_instance_url',
  otelCollectorAddress: 'otel_collector_address',
  useCasesSuggestUseContent: 'use_cases_suggest_use_content',
  useCasesSuggestExcludedSignals: 'use_cases_suggest_excluded_signals',
  useCasesMinutesSavedPerSession: 'use_cases_minutes_saved_per_session',
  useCasesLoadedCompAnnual: 'use_cases_loaded_comp_annual',
  processMiningIntervalDays: 'process_mining_interval_days',
  processMiningWindowDays: 'process_mining_window_days',
  processMiningMinUsers: 'process_mining_min_users',
  processMiningMaxOpenPerDept: 'process_mining_max_open_per_dept',
  processMiningModel: 'process_mining_model',
  processMiningDenylist: 'process_mining_denylist',
  processMiningLastRun: 'process_mining_last_run',
  skillDraftMinPeople: 'skill_draft_min_people',
  skillDraftMinPrompts: 'skill_draft_min_prompts',
  skillDraftMinDays: 'skill_draft_min_days',
  skillDraftMinFollowUps: 'skill_draft_min_follow_ups',
  skillDraftSoloMinDays: 'skill_draft_solo_min_days',
  skillDraftSoloMinWeeks: 'skill_draft_solo_min_weeks',
  skillDraftModel: 'skill_draft_model',
  useCaseJudgeModel: 'use_case_judge_model',
  useCaseJudgeLastRun: 'use_case_judge_last_run',
  useCasesTrackerCursors: 'use_cases_tracker_cursors',
  useCasesTrackerLastRun: 'use_cases_tracker_last_run',
  useCasesTrackerIntervalHours: 'use_cases_tracker_interval_hours',
  useCasesAdoptedMinWeeks: 'use_cases_adopted_min_weeks',
  useCasesAdoptedMinUsers: 'use_cases_adopted_min_users',
  useCasesAtRiskQuietWeeks: 'use_cases_at_risk_quiet_weeks',
  useCasesNotSeenQuietWeeks: 'use_cases_not_seen_quiet_weeks',
  financeInsightModel: 'finance_insight_model',
  financeDriftAlertThresholdPct: 'finance_drift_alert_threshold_pct',
  financeEnterpriseMock: 'finance_enterprise_mock',
  complianceAccessKey: 'compliance_access_key',
  complianceSyncIntervalMinutes: 'compliance_sync_interval_minutes',
  complianceBackfillDays: 'compliance_backfill_days',
  complianceChatsPerRun: 'compliance_chats_per_run',
  complianceChatCursor: 'compliance_chat_cursor',
  complianceActivityCursor: 'compliance_activity_cursor',
  complianceActivityCursorAsc: 'compliance_activity_cursor_asc',
  complianceActivityBackfillDays: 'compliance_activity_backfill_days',
  complianceActivitySyncEnabled: 'compliance_activity_sync_enabled',
  complianceActivityExcludedTypes: 'compliance_activity_excluded_types',
  complianceLastSyncAt: 'compliance_last_sync_at',
  complianceLastSyncStats: 'compliance_last_sync_stats',
  highlightsModel: 'highlights_model',
  highlightsEnabled: 'highlights_enabled',
  highlightsIncludeNames: 'highlights_include_names',
  classifierDrainMaxPasses: 'classifier_drain_max_passes',
};

/**
 * Keys encrypted at rest (item 12). Encryption had been retired
 * because the key and the SQLite file sat on the same volume; every hub now
 * runs on RDS with the key held apart in Secrets Manager, so an RDS snapshot
 * or dump no longer exposes these values. Must match lib/config-secrets.ts's
 * registry (test/config-secret-encryption-pg.test.ts pins it).
 */
const SENSITIVE_KEYS = new Set<keyof AppConfig>([
  'anthropicAdminApiKey',
  'anthropicAnalyticsApiKey',
  'anthropicAiApiKey',
  'otelEndpointSecret',
  'archiveAccessKeyId',
  'archiveSecretAccessKey',
  'smtpPassword',
  'githubToken',
  'digestSlackWebhookUrl',
  'ssoClientSecret',
  'dxApiKey',
  'complianceAccessKey',
  'alertsSlackWebhookUrl',
]);

export const ENCRYPTED_CONFIG_KEYS: ReadonlySet<keyof AppConfig> = SENSITIVE_KEYS;

/** Value as it is written to the config table: sensitive keys are encrypted. */
function storeValue(key: keyof AppConfig, value: string): string {
  return SENSITIVE_KEYS.has(key) && value && !isEncrypted(value) ? encryptSecret(value) : value;
}

const reportedUnreadable = new Set<string>();
/**
 * Decrypt a stored sensitive value. A value that cannot be decrypted (a
 * changed CCC_ENCRYPTION_KEY) reads as '' — and is recorded once per process
 * in error_events so the integration never fails silently; System health and
 * its alert read getUnreadableSecretKeys().
 */
function readSecret(key: keyof AppConfig, stored: string): string {
  const v = decryptSecret(stored);
  if (!v && isEncrypted(stored) && !reportedUnreadable.has(key)) {
    reportedUnreadable.add(key);
    void (async () => {
      try {
        const { insertErrorEvents } = await import('./db/error-queries');
        await insertErrorEvents([{ severity: 'error', source: 'config-secret', message: `Stored ${key} cannot be decrypted with this server's CCC_ENCRYPTION_KEY. Re-enter it on the admin page, or restore the key the value was saved with.` }]);
      } catch { /* recording must never break a config read */ }
    })();
  }
  return v;
}

/** Sensitive keys stored in the table but unreadable with the current key. */
export async function getUnreadableSecretKeys(): Promise<(keyof AppConfig)[]> {
  const db = await getTypedClient();
  const rows = await db.select({ key: schema.config.key, value: schema.config.value }).from(schema.config);
  const byDbKey = new Map(rows.map(r => [r.key, r.value]));
  const out: (keyof AppConfig)[] = [];
  for (const k of SENSITIVE_KEYS) {
    const stored = byDbKey.get(CONFIG_KEYS[k]);
    if (stored && isEncrypted(stored) && !decryptSecret(stored)) out.push(k);
  }
  return out;
}

/**
 * Encrypt any sensitive value still stored as plaintext (run at boot). Safe to
 * run on every instance at once: each UPDATE only matches the exact plaintext
 * it read, so a row another instance already encrypted is left alone.
 */
export async function encryptStoredSecrets(): Promise<{ encrypted: number }> {
  const db = await getTypedClient();
  const t = schema.config;
  let encrypted = 0;
  for (const k of SENSITIVE_KEYS) {
    const dbKey = CONFIG_KEYS[k];
    const rows = await db.select({ value: t.value }).from(t).where(eq(t.key, dbKey)).limit(1);
    const plain = rows[0]?.value;
    if (!plain || isEncrypted(plain)) continue;
    const res = await db.update(t).set({ value: encryptSecret(plain) }).where(and(eq(t.key, dbKey), eq(t.value, plain)));
    encrypted += Number((res as unknown as { rowCount?: number | null }).rowCount ?? 0);
  }
  return { encrypted };
}

const ENV_FALLBACKS: Partial<Record<keyof AppConfig, string>> = {
  anthropicAdminApiKey: 'ANTHROPIC_ADMIN_API_KEY',
  anthropicAnalyticsApiKey: 'ANTHROPIC_ANALYTICS_API_KEY',
  anthropicAiApiKey: 'ANTHROPIC_AI_API_KEY',
  otelEndpointSecret: 'OTEL_ENDPOINT_SECRET',
  ingestIntervalSeconds: 'INGEST_INTERVAL_SECONDS',
  complianceAccessKey: 'COMPLIANCE_ACCESS_KEY',
};

/**
 * Get a single config value. Priority: config table > env var > default.
 */
export async function getConfigValue(key: keyof AppConfig): Promise<string> {
  const db = await getTypedClient();
  const dbKey = CONFIG_KEYS[key];

  const t = schema.config;
  const rows = await db.select({ value: t.value }).from(t).where(eq(t.key, dbKey)).limit(1);
  const row = rows[0];
  if (row?.value) {
    return SENSITIVE_KEYS.has(key) ? readSecret(key, row.value) : row.value;
  }

  const envKey = ENV_FALLBACKS[key];
  if (envKey && process.env[envKey]) return process.env[envKey]!;

  return '';
}

/**
 * Set a config value in the database.
 */
export async function setConfigValue(key: keyof AppConfig, value: string): Promise<void> {
  const db = await getTypedClient();
  const dbKey = CONFIG_KEYS[key];
  const t = schema.config;
  const nowS = Math.floor(Date.now() / 1000); // app clock
  await db
    .insert(t)
    .values({ key: dbKey, value: storeValue(key, value), updated_at: nowS })
    .onConflictDoUpdate({
      target: t.key,
      set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
    });
}

/**
 * Delete config rows for the given keys — used by DELETE /api/config/secret
 * to remove a secret plus its job-written state (cursors, last-sync stats).
 * Single DELETE statement (atomic); absent rows are a no-op.
 */
export async function deleteConfigValues(keys: (keyof AppConfig)[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await getTypedClient();
  const t = schema.config;
  const dbKeys = keys.map((k) => CONFIG_KEYS[k]);
  await db.delete(t).where(inArray(t.key, dbKeys));
}

/**
 * Get all config values as a typed object (single query).
 */
export async function getAllConfig(): Promise<AppConfig> {
  const db = await getTypedClient();

  // Fetch all config rows in one query
  const t = schema.config;
  const rows = await db.select({ key: t.key, value: t.value }).from(t);
  const dbMap = new Map(rows.map(r => [r.key, r.value]));

  // Resolve a config value: DB > env > default
  function resolve(key: keyof AppConfig, defaultValue = ''): string {
    const dbKey = CONFIG_KEYS[key];
    const raw = dbMap.get(dbKey);
    if (raw) return SENSITIVE_KEYS.has(key) ? readSecret(key, raw) : raw;
    const envKey = ENV_FALLBACKS[key];
    if (envKey && process.env[envKey]) return process.env[envKey]!;
    return defaultValue;
  }

  return {
    anthropicAdminApiKey: resolve('anthropicAdminApiKey'),
    anthropicAnalyticsApiKey: resolve('anthropicAnalyticsApiKey'),
    anthropicAiApiKey: resolve('anthropicAiApiKey'),
    otelEndpointSecret: resolve('otelEndpointSecret'),
    ingestIntervalSeconds: parseInt(resolve('ingestIntervalSeconds', '60'), 10),
    organisationName: resolve('organisationName'),
    acceptableUsePolicy: resolve('acceptableUsePolicy'),
    complianceLastCursor: resolve('complianceLastCursor'),
    analyticsLastDate: resolve('analyticsLastDate'),
    retentionCoworkDays: parseInt(resolve('retentionCoworkDays', '90'), 10),
    retentionOtelDays: parseInt(resolve('retentionOtelDays', '30'), 10),
    retentionComplianceDays: parseInt(resolve('retentionComplianceDays', '365'), 10),
    retentionChatDays: parseInt(resolve('retentionChatDays', '90'), 10),
    retentionMode: (resolve('retentionMode', 'strip') === 'purge' ? 'purge' : 'strip'),
    retentionLastRun: resolve('retentionLastRun'),
    retentionLastResult: resolve('retentionLastResult'),
    anomalyDetectionLastRun: resolve('anomalyDetectionLastRun'),
    retentionErrorDays: parseInt(resolve('retentionErrorDays', '90'), 10),
    retentionCodeDays: parseInt(resolve('retentionCodeDays', '90'), 10),
    retentionAlertsDays: parseInt(resolve('retentionAlertsDays', '90'), 10),
    retentionAnalyticsDays: parseInt(resolve('retentionAnalyticsDays', '365'), 10),
    archiveEnabled: resolve('archiveEnabled') === 'true',
    archiveProvider: resolve('archiveProvider'),
    archiveBucket: resolve('archiveBucket'),
    archiveRegion: resolve('archiveRegion'),
    archiveAccessKeyId: resolve('archiveAccessKeyId'),
    archiveSecretAccessKey: resolve('archiveSecretAccessKey'),
    dpiaCompleted: resolve('dpiaCompleted') === 'true',
    dpiaDate: resolve('dpiaDate'),
    dataProtectionOfficer: resolve('dataProtectionOfficer'),
    gdprApplicable: resolve('gdprApplicable', 'true') === 'true',
    lgpdApplicable: resolve('lgpdApplicable', 'false') === 'true',
    dataProtectionEncarregado: resolve('dataProtectionEncarregado'),
    ripdCompleted: resolve('ripdCompleted') === 'true',
    ripdDate: resolve('ripdDate'),
    aiActRiskTier: resolve('aiActRiskTier', 'not-assessed'),
    aiActTransparencyNotice: resolve('aiActTransparencyNotice') === 'true',
    isoControlOwner: resolve('isoControlOwner'),
    isoCertificationStatus: resolve('isoCertificationStatus', 'not-started'),
    iso42001Owner: resolve('iso42001Owner'),
    iso42001AssessmentStatus: resolve('iso42001AssessmentStatus', 'not-started'),
    riskTokenMultiplier: parseInt(resolve('riskTokenMultiplier', '3'), 10),
    riskFileAccessLimit: parseInt(resolve('riskFileAccessLimit', '50'), 10),
    riskInactivityDays: parseInt(resolve('riskInactivityDays', '14'), 10),
    riskSensitivity: (['conservative', 'balanced', 'aggressive'].includes(resolve('riskSensitivity', 'balanced'))
      ? resolve('riskSensitivity', 'balanced') : 'balanced') as 'conservative' | 'balanced' | 'aggressive',
    riskAlertAnomalyEnabled: resolve('riskAlertAnomalyEnabled', 'true') === 'true',
    riskAlertPolicyEnabled: resolve('riskAlertPolicyEnabled', 'true') === 'true',
    riskAlertAdoptionEnabled: resolve('riskAlertAdoptionEnabled', 'true') === 'true',
    riskAlertRiskEnabled: resolve('riskAlertRiskEnabled', 'true') === 'true',
    riskAlertPulseCapabilityEnabled: resolve('riskAlertPulseCapabilityEnabled', 'false') === 'true',
    riskAlertFinanceDriftEnabled: resolve('riskAlertFinanceDriftEnabled', 'true'),
    riskAlertUseCaseEnabled: resolve('riskAlertUseCaseEnabled', 'true'),
    riskSeverityLowDesc: resolve('riskSeverityLowDesc', 'Informational. Something to be aware of. A single PII flag, a user trying a new surface.'),
    riskSeverityMediumDesc: resolve('riskSeverityMediumDesc', 'Worth a look. A pattern forming: multiple PII flags from the same user, unusual access patterns.'),
    riskSeverityHighDesc: resolve('riskSeverityHighDesc', 'Needs attention. Systematic issues, repeated policy violations, credential-like content in prompts.'),
    riskSeverityCriticalDesc: resolve('riskSeverityCriticalDesc', 'Actual incident. Data exfiltration patterns, widespread misuse, real security breach indicators.'),
    smtpHost: resolve('smtpHost'),
    smtpPort: resolve('smtpPort', '587'),
    smtpUser: resolve('smtpUser'),
    smtpPassword: resolve('smtpPassword'),
    smtpFromAddress: resolve('smtpFromAddress'),
    smtpFromName: resolve('smtpFromName', 'Frontier Command Centre'),
    // Work Pulse
    pulseEnabled: resolve('pulseEnabled') === 'true',
    pulseClassifierModel: resolve('pulseClassifierModel', 'claude-haiku-4-5-20251001'),
    // The same constant the briefing jobs fall back to, so /admin/pulse shows
    // the model they actually use. The old default here,
    // claude-opus-4-5-20251001, was never a valid model ID.
    pulseBriefingModel: resolve('pulseBriefingModel', BRIEFING_DEFAULT_MODEL),
    // Blank = personal briefings follow the Core AI model (getUserBriefingModel);
    // the admin page shows which model that currently is.
    pulseUserBriefingModel: resolve('pulseUserBriefingModel'),
    pulseSessionDescriptionsEnabled: resolve('pulseSessionDescriptionsEnabled', 'true'),
    humanTimeEnabled: resolve('humanTimeEnabled', 'false'),
    humanTimeCodeEnabled: resolve('humanTimeCodeEnabled'),
    systemHealthAlertsEnabled: resolve('systemHealthAlertsEnabled', 'false'),
    telemetrySilenceHours: resolve('telemetrySilenceHours', '3'),
    telemetrySilenceTimezone: resolve('telemetrySilenceTimezone', 'Europe/London'),
    telemetrySilenceWorkHours: resolve('telemetrySilenceWorkHours', '08-18'),
    setupGuideHidden: resolve('setupGuideHidden', 'false'),
    setupRubricReviewed: resolve('setupRubricReviewed', 'false'),
    setupStepsDone: resolve('setupStepsDone', '[]'),
    setupFirstCodeAt: resolve('setupFirstCodeAt'),
    setupFirstCoworkAt: resolve('setupFirstCoworkAt'),
    humanTimeMinSessionsForRatio: resolve('humanTimeMinSessionsForRatio', '20'),
    coreAiModel: resolve('coreAiModel', CLAUDE_MODEL),
    otiThresholds: resolve('otiThresholds', '{"progress":1.2,"uplift":1.5}'),
    ddsSupportFloor: resolve('ddsSupportFloor', '1.5'),
    pulseClassifierLastRun: resolve('pulseClassifierLastRun'),
    pulseAuditLastRun: resolve('pulseAuditLastRun'),
    pulseSessionDescriptionsLastRun: resolve('pulseSessionDescriptionsLastRun'),
    pulseAggregatorLastRun: resolve('pulseAggregatorLastRun'),
    pulseAggregatorDailyLastRun: resolve('pulseAggregatorDailyLastRun'),
    coworkSessionAggLastRun: resolve('coworkSessionAggLastRun'),
    pulseWeeklyBriefingLastRun: resolve('pulseWeeklyBriefingLastRun'),
    pulseCioBriefingLastRun: resolve('pulseCioBriefingLastRun'),
    pulseClassifierConfig: resolve('pulseClassifierConfig'),
    // Developer Pulse
    codePulseEnabled: resolve('codePulseEnabled', 'true') === 'true',
    codeModelRates: resolve('codeModelRates', '{}'),
    codeAggregatorLastRun: resolve('codeAggregatorLastRun'),
    codeAlertCostSpikeEnabled: resolve('codeAlertCostSpikeEnabled', 'true') === 'true',
    codeCostSpikeMultiplier: parseFloat(resolve('codeCostSpikeMultiplier', '3')),
    codeCostSpikeFloorUsd: parseFloat(resolve('codeCostSpikeFloorUsd', '100')),
    codeAlertModelPolicyEnabled: resolve('codeAlertModelPolicyEnabled', 'false') === 'true',
    codeModelAllowlist: resolve('codeModelAllowlist', '[]'),
    codeAlertRepoExposureEnabled: resolve('codeAlertRepoExposureEnabled', 'false') === 'true',
    codeSensitiveRepoPatterns: resolve('codeSensitiveRepoPatterns', '[]'),
    codeAlertFrictionEnabled: resolve('codeAlertFrictionEnabled', 'false') === 'true',
    codeFrictionThreshold: parseFloat(resolve('codeFrictionThreshold', '0.25')),
    codeClassifierEnabled: resolve('codeClassifierEnabled', 'true') === 'true',
    codeClassifierModel: resolve('codeClassifierModel', 'claude-haiku-4-5-20251001'),
    codeClassifierIncludePrompt: resolve('codeClassifierIncludePrompt', 'true') === 'true',
    codeClassifierLastRun: resolve('codeClassifierLastRun'),
    codeClassifierConfig: resolve('codeClassifierConfig'),
    codeBriefingModel: resolve('codeBriefingModel'),
    codeValueEnabled: resolve('codeValueEnabled', 'true') !== 'false',
    codeValueLiftPct: resolve('codeValueLiftPct', '30'),
    codeValueLoadedComp: resolve('codeValueLoadedComp', '300000'),
    codeValueCodingHrs: resolve('codeValueCodingHrs', '15'),
    codeValueTeamSize: resolve('codeValueTeamSize', ''),
    codeValueAnnualSpend: resolve('codeValueAnnualSpend', ''),
    timeSavedMinPerPr: resolve('timeSavedMinPerPr', ''),
    timeSavedMinPerCommit: resolve('timeSavedMinPerCommit', ''),
    timeSavedMinPerCoworkSession: resolve('timeSavedMinPerCoworkSession', ''),
    timeSavedMinPerChatConversation: resolve('timeSavedMinPerChatConversation', ''),
    githubToken: resolve('githubToken'),
    githubSyncLastRun: resolve('githubSyncLastRun'),
    codeBriefingLastRun: resolve('codeBriefingLastRun'),
    otelUserStaleDays: parseInt(resolve('otelUserStaleDays', '30'), 10),
    otelUserCleanupEnabled: resolve('otelUserCleanupEnabled', 'true') === 'true',
    userCleanupLastRun: resolve('userCleanupLastRun'),
    // File upload alert patterns
    fileUploadAlertPatterns: resolve('fileUploadAlertPatterns'),
    otelExcludedEmails: resolve('otelExcludedEmails'),
    // Weekly Exec Digest
    digestEnabled: resolve('digestEnabled') === 'true',
    digestSlackWebhookUrl: resolve('digestSlackWebhookUrl'),
    digestRecipients: resolve('digestRecipients'),
    // Default 7 matches DEFAULT_SEND_HOUR_UTC in lib/digest/schedule.ts —
    // keep these in sync so the admin card never displays a send hour the
    // scheduler doesn't actually use.
    digestSendHourUtc: parseInt(resolve('digestSendHourUtc', '7'), 10),
    digestHubUrl: resolve('digestHubUrl', 'http://localhost:3001'),
    digestLastSentWeek: resolve('digestLastSentWeek'),
    // High-Priority Alerts -> Slack
    alertsSlackEnabled: resolve('alertsSlackEnabled', 'false') === 'true',
    alertsSlackWebhookUrl: resolve('alertsSlackWebhookUrl'),
    alertsSlackSweepLastRun: resolve('alertsSlackSweepLastRun'),
    alertsSlackSweepCursor: resolve('alertsSlackSweepCursor'),
    // Licensed seats
    licensedSeats: resolve('licensedSeats'),
    // OIDC SSO
    ssoEnabled: resolve('ssoEnabled', 'false') === 'true',
    ssoIssuerUrl: resolve('ssoIssuerUrl'),
    ssoClientId: resolve('ssoClientId'),
    ssoClientSecret: resolve('ssoClientSecret'),
    ssoProviderLabel: resolve('ssoProviderLabel', 'SSO'),
    ssoRedirectBaseUrl: resolve('ssoRedirectBaseUrl'),
    // Use Cases register (Phase 1)
    useCasesEnabled: resolve('useCasesEnabled', 'false') === 'true',
    useCasesExtractModel: resolve('useCasesExtractModel', 'claude-haiku-4-5-20251001'),
    useCasesIdeateModel: resolve('useCasesIdeateModel', 'claude-sonnet-5'),
    // Cost & Chargeback (dormant)
    chargebackEnabled: resolve('chargebackEnabled', 'false') === 'true',
    financeModelEfficiencyEnabled: resolve('financeModelEfficiencyEnabled', 'false') === 'true',
    finopsSeatPriceMonthly: resolve('finopsSeatPriceMonthly', ''),
    // Dev Framework Alignment (dormant)
    dxFrameworkEnabled: resolve('dxFrameworkEnabled', 'false') === 'true',
    dxFrameworkMock: resolve('dxFrameworkMock', 'false'),
    dxApiKey: resolve('dxApiKey', ''),
    dxInstanceUrl: resolve('dxInstanceUrl', ''),
    otelCollectorAddress: resolve('otelCollectorAddress', ''),
    useCasesSuggestUseContent: resolve('useCasesSuggestUseContent', 'true'),
    useCasesSuggestExcludedSignals: resolve('useCasesSuggestExcludedSignals', '["anthropic-skills:docx","anthropic-skills:pptx","basic_drafting","transcription"]'),
    useCasesMinutesSavedPerSession: resolve('useCasesMinutesSavedPerSession', '30'),
    useCasesLoadedCompAnnual: resolve('useCasesLoadedCompAnnual', '90000'),
    processMiningIntervalDays: resolve('processMiningIntervalDays', '7'),
    processMiningWindowDays: resolve('processMiningWindowDays', '28'),
    processMiningMinUsers: resolve('processMiningMinUsers', '2'),
    processMiningMaxOpenPerDept: resolve('processMiningMaxOpenPerDept', '5'),
    processMiningModel: resolve('processMiningModel', ''),
    processMiningDenylist: resolve('processMiningDenylist', ''),
    processMiningLastRun: resolve('processMiningLastRun', ''),
    skillDraftMinPeople: resolve('skillDraftMinPeople', '3'),
    skillDraftMinPrompts: resolve('skillDraftMinPrompts', '10'),
    skillDraftMinDays: resolve('skillDraftMinDays', '3'),
    skillDraftMinFollowUps: resolve('skillDraftMinFollowUps', '3'),
    skillDraftSoloMinDays: resolve('skillDraftSoloMinDays', '6'),
    skillDraftSoloMinWeeks: resolve('skillDraftSoloMinWeeks', '4'),
    skillDraftModel: resolve('skillDraftModel', 'claude-sonnet-5'),
    useCaseJudgeModel: resolve('useCaseJudgeModel', 'claude-sonnet-5'),
    useCaseJudgeLastRun: resolve('useCaseJudgeLastRun', ''),
    useCasesTrackerCursors: resolve('useCasesTrackerCursors', ''),
    useCasesTrackerLastRun: resolve('useCasesTrackerLastRun', ''),
    useCasesTrackerIntervalHours: resolve('useCasesTrackerIntervalHours', '1'),
    useCasesAdoptedMinWeeks: resolve('useCasesAdoptedMinWeeks', '3'),
    useCasesAdoptedMinUsers: resolve('useCasesAdoptedMinUsers', '2'),
    useCasesAtRiskQuietWeeks: resolve('useCasesAtRiskQuietWeeks', '2'),
    useCasesNotSeenQuietWeeks: resolve('useCasesNotSeenQuietWeeks', '6'),
    financeInsightModel: resolve('financeInsightModel', 'claude-haiku-4-5-20251001'),
    financeDriftAlertThresholdPct: resolve('financeDriftAlertThresholdPct', '10'),
    financeEnterpriseMock: resolve('financeEnterpriseMock', 'false'),
    complianceAccessKey: resolve('complianceAccessKey'),
    complianceSyncIntervalMinutes: resolve('complianceSyncIntervalMinutes', '2'),
    complianceBackfillDays: resolve('complianceBackfillDays', '30'),
    complianceChatsPerRun: resolve('complianceChatsPerRun', '200'),
    complianceChatCursor: resolve('complianceChatCursor'),
    complianceActivityCursor: resolve('complianceActivityCursor'),
    complianceActivityCursorAsc: resolve('complianceActivityCursorAsc'),
    complianceActivityBackfillDays: resolve('complianceActivityBackfillDays', '7'),
    complianceActivitySyncEnabled: resolve('complianceActivitySyncEnabled', 'false') === 'true',
    complianceActivityExcludedTypes: resolve('complianceActivityExcludedTypes', '["compliance_api_accessed"]'),
    complianceLastSyncAt: resolve('complianceLastSyncAt'),
    complianceLastSyncStats: resolve('complianceLastSyncStats'),
    highlightsModel: resolve('highlightsModel'),
    highlightsEnabled: resolve('highlightsEnabled', 'false'),
    highlightsIncludeNames: resolve('highlightsIncludeNames', 'false'),
    classifierDrainMaxPasses: parseInt(resolve('classifierDrainMaxPasses', '5'), 10),
  } as AppConfig;
}

/**
 * Save multiple config values at once.
 */
export async function saveConfig(values: Partial<Record<keyof AppConfig, string>>): Promise<void> {
  const client = await getTypedClient();
  const t = schema.config;
  const nowS = Math.floor(Date.now() / 1000); // app clock

  await withTx(client, async (tx) => {
    for (const [key, value] of Object.entries(values)) {
      const configKey = key as keyof AppConfig;
      const dbKey = CONFIG_KEYS[configKey];
      if (dbKey && value !== undefined) {
        await tx
          .insert(t)
          .values({ key: dbKey, value: storeValue(configKey, String(value)), updated_at: nowS })
          .onConflictDoUpdate({
            target: t.key,
            set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
          });
      }
    }
  });
}

/**
 * Check whether a specific API key is configured (non-empty).
 */
export async function isConfigured(key: keyof AppConfig): Promise<boolean> {
  return (await getConfigValue(key)) !== '';
}

/**
 * Check whether OTel is configured (secret is set).
 */
export async function isOtelConfigured(): Promise<boolean> {
  return isConfigured('otelEndpointSecret');
}

export interface DataSourceStatus {
  coworkContent: boolean;
  otelCowork: boolean;        // OTel Cowork data received (users with source='otel')
  complianceApi: boolean;
  analyticsApi: boolean;
  aiFeatures: boolean;
  mode: 'max' | 'enterprise';
}

export async function getDataSourceStatus(): Promise<DataSourceStatus> {
  const db = await getTypedClient();

  let coworkContent = false;
  try {
    const coworkRows = await db.select({ one: sql<number>`1` }).from(schema.coworkMessages).limit(1);
    coworkContent = coworkRows.length > 0;
  } catch { /* table might not exist yet */ }

  const complianceKey = await getConfigValue('anthropicAdminApiKey');
  const analyticsKey = await getConfigValue('anthropicAnalyticsApiKey');
  const complianceApi = !!complianceKey;
  const analyticsApi = !!analyticsKey;

  const aiKey = await getConfigValue('anthropicAiApiKey');
  const aiFeatures = !!aiKey;
  const mode = complianceApi || analyticsApi ? 'enterprise' : 'max';

  // Check if OTel Cowork data is present (users with source='otel')
  let otelCowork = false;
  try {
    const otelUserRows = await db
      .select({ one: sql<number>`1` })
      .from(schema.users)
      .where(eq(schema.users.source, 'otel'))
      .limit(1);
    otelCowork = otelUserRows.length > 0;
  } catch { /* users table may not have source column yet */ }

  return { coworkContent, otelCowork, complianceApi, analyticsApi, aiFeatures, mode };
}
