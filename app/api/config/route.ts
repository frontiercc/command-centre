// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getAllConfig, saveConfig, AppConfig } from '@/lib/config';
import { requireAdmin, getAdminSession } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { SENSITIVE_KEYS } from '@/lib/config-secrets';
import { normaliseCollectorAddress } from '@/lib/setup/collector';

function maskValue(value: string): string {
  if (!value || value.length < 8) return value ? '••••••••' : '';
  return value.slice(0, 7) + '••••••••';
}

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

/** Config keys a non-admin page reads. Never add a sensitive key here. */
const NON_ADMIN_CONFIG_KEYS = [
  'organisationName', 'useCasesEnabled', 'chargebackEnabled', 'pulseEnabled',
  'pulseClassifierModel', 'pulseBriefingModel', 'pulseUserBriefingModel', 'coreAiModel',
  'gdprApplicable', 'lgpdApplicable',
  'ddsSupportFloor',
] as const;

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'config', action: 'READ', outcome: 'success' });
  const config = await getAllConfig();

  // Non-admins get only the handful of feature flags and display settings the
  // pages they can reach actually read (sidebar, mobile nav, dashboard,
  // reports, department benchmark, the manager's /admin/pulse overview).
  // Everything else — integration settings, endpoints, thresholds — is admin only.
  if (session.role !== 'admin') {
    const shared: Record<string, string | number | boolean> = {};
    const all = config as unknown as Record<string, string | number | boolean>;
    for (const key of NON_ADMIN_CONFIG_KEYS) {
      if (key in all) shared[key] = all[key];
    }
    return NextResponse.json(shared);
  }

  // Mask sensitive values before returning to client
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_KEYS.includes(key as keyof AppConfig)) {
      safe[key] = maskValue(String(value));
    } else {
      safe[key] = value;
    }
  }

  return NextResponse.json(safe);
}

export async function POST(request: NextRequest) {
  const adminSession = await requireAdmin(request);
  if (!adminSession) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  const body = await request.json();

  // Only allow known config keys
  const allowedKeys = new Set<string>([
    'anthropicAdminApiKey',
    'anthropicAnalyticsApiKey',
    'anthropicAiApiKey',
    'otiThresholds',
    'ddsSupportFloor',
    'otelEndpointSecret',
    'ingestIntervalSeconds',
    'organisationName',
    'acceptableUsePolicy',
    'retentionCoworkDays',
    'retentionOtelDays',
    'retentionComplianceDays',
    'retentionChatDays',
    'retentionMode',
    'retentionErrorDays',
    'retentionCodeDays',
    'retentionAlertsDays',
    'retentionAnalyticsDays',
    'dpiaCompleted',
    'dpiaDate',
    'dataProtectionOfficer',
    'gdprApplicable',
    'lgpdApplicable',
    'dataProtectionEncarregado',
    'ripdCompleted',
    'ripdDate',
    'aiActRiskTier',
    'aiActTransparencyNotice',
    'isoControlOwner',
    'isoCertificationStatus',
    'iso42001Owner',
    'iso42001AssessmentStatus',
    'riskTokenMultiplier',
    'riskFileAccessLimit',
    'riskInactivityDays',
    'riskSensitivity',
    'riskAlertAnomalyEnabled',
    'riskAlertPolicyEnabled',
    'riskAlertAdoptionEnabled',
    'riskAlertRiskEnabled',
    'riskAlertPulseCapabilityEnabled',
    'riskAlertFinanceDriftEnabled',
    'riskAlertUseCaseEnabled',
    'codeAlertCostSpikeEnabled',
    'codeAlertModelPolicyEnabled',
    'codeAlertRepoExposureEnabled',
    'codeAlertFrictionEnabled',
    'codeCostSpikeMultiplier',
    'codeCostSpikeFloorUsd',
    'codeFrictionThreshold',
    'codeModelAllowlist',
    'codeSensitiveRepoPatterns',
    'codeClassifierEnabled',
    'codeClassifierModel',
    'codeClassifierIncludePrompt',
    'codeClassifierConfig',
    'codeBriefingModel',
    'classifierDrainMaxPasses',
    'codeValueEnabled',
    'codeValueLiftPct',
    'codeValueLoadedComp',
    'codeValueCodingHrs',
    'codeValueTeamSize',
    'codeValueAnnualSpend',
    'timeSavedMinPerPr',
    'timeSavedMinPerCommit',
    'timeSavedMinPerCoworkSession',
    'timeSavedMinPerChatConversation',
    'riskSeverityLowDesc',
    'riskSeverityMediumDesc',
    'riskSeverityHighDesc',
    'riskSeverityCriticalDesc',
    'pulseEnabled',
    'pulseClassifierModel',
    'pulseBriefingModel',
    'pulseUserBriefingModel',
    'pulseSessionDescriptionsEnabled',
    'humanTimeEnabled',
    'humanTimeCodeEnabled',
    'systemHealthAlertsEnabled',
    'telemetrySilenceHours',
    'telemetrySilenceTimezone',
    'telemetrySilenceWorkHours',
    'humanTimeMinSessionsForRatio',
    'coreAiModel',
    'smtpHost',
    'smtpPort',
    'smtpUser',
    'smtpPassword',
    'smtpFromAddress',
    'smtpFromName',
    'otelUserStaleDays',
    'otelUserCleanupEnabled',
    'fileUploadAlertPatterns',
    'otelExcludedEmails',
    'digestEnabled',
    'digestSlackWebhookUrl',
    'digestRecipients',
    'digestSendHourUtc',
    'digestHubUrl',
    'highlightsEnabled',
    'highlightsModel',
    'highlightsIncludeNames',
    'alertsSlackEnabled',
    'alertsSlackWebhookUrl',
    'licensedSeats',
    'ssoEnabled',
    'ssoIssuerUrl',
    'ssoClientId',
    'ssoClientSecret',
    'ssoProviderLabel',
    'ssoRedirectBaseUrl',
    'otelCollectorAddress',
    'useCasesEnabled',
    'chargebackEnabled',
    'financeModelEfficiencyEnabled',
    'finopsSeatPriceMonthly',
    'useCasesExtractModel',
    'useCasesIdeateModel',
    'useCasesSuggestUseContent',
    'useCasesSuggestExcludedSignals',
    'useCasesTrackerIntervalHours',
    'useCasesAdoptedMinWeeks',
    'useCasesAdoptedMinUsers',
    'useCasesAtRiskQuietWeeks',
    'useCasesNotSeenQuietWeeks',
    'useCasesMinutesSavedPerSession',
    'useCasesLoadedCompAnnual',
    'processMiningIntervalDays',
    'processMiningWindowDays',
    'processMiningMinUsers',
    'processMiningMaxOpenPerDept',
    'processMiningModel',
    'processMiningDenylist',
    'skillDraftMinPeople',
    'skillDraftMinPrompts',
    'skillDraftMinDays',
    'skillDraftMinFollowUps',
    'skillDraftSoloMinDays',
    'skillDraftSoloMinWeeks',
    'skillDraftModel',
    'useCaseJudgeModel',
    'financeInsightModel',
    'financeDriftAlertThresholdPct',
    'financeEnterpriseMock',
    'dxFrameworkEnabled',
    'dxFrameworkMock',
    'dxApiKey',
    'dxInstanceUrl',
    'complianceAccessKey',
    'complianceSyncIntervalMinutes',
    'complianceBackfillDays',
    'complianceChatsPerRun',
    'complianceActivityBackfillDays',
    'complianceActivitySyncEnabled',
    'complianceActivityExcludedTypes',
  ]);

  const values: Partial<Record<keyof AppConfig, string>> = {};
  const ignored: Array<{ key: string; reason: 'masked' | 'blank-not-clearable' }> = [];
  for (const [key, value] of Object.entries(body)) {
    // Allow empty strings for compliance text fields (so they can be cleared)
    const clearableKeys = new Set([
      'dataProtectionOfficer', 'dpiaDate', 'dataProtectionEncarregado', 'ripdDate', 'isoControlOwner', 'iso42001Owner',
      'riskSeverityLowDesc', 'riskSeverityMediumDesc', 'riskSeverityHighDesc', 'riskSeverityCriticalDesc',
      'codeValueTeamSize', 'codeValueAnnualSpend',
      'codeValueLiftPct', 'codeValueLoadedComp', 'codeValueCodingHrs',
      'timeSavedMinPerPr', 'timeSavedMinPerCommit', 'timeSavedMinPerCoworkSession', 'timeSavedMinPerChatConversation',
      'digestRecipients', 'digestHubUrl',
      // Blank = personal briefings follow the Core AI model again.
      'pulseUserBriefingModel',
      // Blank = Developer Pulse briefings use the organisation briefing model again.
      'codeBriefingModel',
      'licensedSeats', 'finopsSeatPriceMonthly',
      'ssoIssuerUrl', 'ssoClientId', 'ssoProviderLabel', 'ssoRedirectBaseUrl',
      'dxInstanceUrl',
      // Blank = the address falls back to CCC_COLLECTOR_ADDRESS, then localhost.
      'otelCollectorAddress',
    ]);
    if (!allowedKeys.has(key) || typeof value !== 'string') continue;
    if (String(value).includes('••••••••')) {
      ignored.push({ key, reason: 'masked' });
      continue;
    }
    if (value === '' && !clearableKeys.has(key)) {
      ignored.push({ key, reason: 'blank-not-clearable' });
      continue;
    }
    values[key as keyof AppConfig] = value;
  }

  // Validate retention day values
  for (const key of ['retentionCoworkDays', 'retentionOtelDays', 'retentionComplianceDays', 'retentionChatDays', 'retentionErrorDays', 'retentionCodeDays', 'retentionAlertsDays', 'retentionAnalyticsDays']) {
    if (values[key as keyof AppConfig]) {
      const val = parseInt(String(values[key as keyof AppConfig]), 10);
      if (isNaN(val) || val < 7) {
        return NextResponse.json({ error: `${key} must be a number >= 7` }, { status: 400 });
      }
    }
  }

  if (values.retentionMode && !['strip', 'purge'].includes(String(values.retentionMode))) {
    return NextResponse.json({ error: 'retentionMode must be "strip" or "purge"' }, { status: 400 });
  }

  // Validate risk scoring thresholds
  for (const key of ['riskTokenMultiplier', 'riskFileAccessLimit', 'riskInactivityDays']) {
    if (values[key as keyof AppConfig]) {
      const val = parseInt(String(values[key as keyof AppConfig]), 10);
      if (isNaN(val) || val < 1) {
        return NextResponse.json({ error: `${key} must be a positive integer` }, { status: 400 });
      }
    }
  }

  if (values.riskSensitivity && !['conservative', 'balanced', 'aggressive'].includes(String(values.riskSensitivity))) {
    return NextResponse.json({ error: 'riskSensitivity must be one of: conservative, balanced, aggressive' }, { status: 400 });
  }

  if (values.aiActRiskTier && !['minimal', 'limited', 'high', 'unacceptable', 'not-assessed'].includes(String(values.aiActRiskTier))) {
    return NextResponse.json({ error: 'aiActRiskTier must be one of: minimal, limited, high, unacceptable, not-assessed' }, { status: 400 });
  }

  if (values.isoCertificationStatus && !['certified', 'in-progress', 'not-started'].includes(String(values.isoCertificationStatus))) {
    return NextResponse.json({ error: 'isoCertificationStatus must be one of: certified, in-progress, not-started' }, { status: 400 });
  }

  // Value calibration validation
  if (values.codeValueLiftPct) {
    const v = parseFloat(String(values.codeValueLiftPct));
    if (isNaN(v) || v < 0 || v > 100) return NextResponse.json({ error: 'codeValueLiftPct must be 0–100' }, { status: 400 });
  }
  for (const key of ['codeValueLoadedComp', 'codeValueCodingHrs', 'codeValueTeamSize', 'codeValueAnnualSpend'] as const) {
    if (values[key]) {
      const v = parseFloat(String(values[key]));
      if (isNaN(v) || v <= 0) return NextResponse.json({ error: `${key} must be a positive number` }, { status: 400 });
    }
  }

  // Weekly Exec Digest validation
  if (values.digestSendHourUtc) {
    const v = parseInt(String(values.digestSendHourUtc), 10);
    if (isNaN(v) || v < 0 || v > 23) {
      return NextResponse.json({ error: 'digestSendHourUtc must be 0–23' }, { status: 400 });
    }
  }
  if (values.digestSlackWebhookUrl) {
    const url = String(values.digestSlackWebhookUrl);
    if (url !== '') {
      try {
        if (new URL(url).protocol !== 'https:') throw new Error('not https');
      } catch {
        return NextResponse.json({ error: 'digestSlackWebhookUrl must be a valid https URL' }, { status: 400 });
      }
    }
  }
  if (values.alertsSlackWebhookUrl) {
    const url = String(values.alertsSlackWebhookUrl);
    if (url !== '') {
      try {
        if (new URL(url).protocol !== 'https:') throw new Error('not https');
      } catch {
        return NextResponse.json({ error: 'alertsSlackWebhookUrl must be a valid https URL' }, { status: 400 });
      }
    }
  }

  if (values.otelCollectorAddress !== undefined) {
    const address = normaliseCollectorAddress(String(values.otelCollectorAddress));
    if (address === null) {
      return NextResponse.json({ error: 'The collector address must be an http or https address, such as https://otel.your-company.com' }, { status: 400 });
    }
    values.otelCollectorAddress = address;
  }

  try {
    await saveConfig(values);
    await logAccess({
      actorId: adminSession.userId!,
      actorEmail: adminSession.email!,
      actorIp: request.headers.get('x-forwarded-for') || undefined,
      resource: 'config',
      action: 'WRITE',
      outcome: 'success',
      detail: `keys=${Object.keys(values).join(',')}`,
    });
    return NextResponse.json({ ok: true, ignored });
  } catch (err) {
    return errorResponse('api/config', err);
  }
}
