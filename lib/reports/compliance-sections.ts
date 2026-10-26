// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { and, eq, gte, sql } from 'drizzle-orm';
import { getConfigValue, getDataSourceStatus } from '@/lib/config';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getOpenAlertsBySeverity, getSurfaceBreakdown, getChatFlaggedCount } from '@/lib/db/queries';
import { PII_PATTERNS } from '@/lib/pii/detect';

// ─── Helpers ──────────────────────────────────────────────────────────────

function toUnix(isoDate: string): number {
  return Math.floor(new Date(isoDate).getTime() / 1000);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Count PII detections in the report period (occurred_at >= startUnix):
 *   1. chat_messages flagged
 *   2. cowork_messages flagged (Cowork and Code)
 * Each PII alert is raised from one of these flagged prompts, so the alerts
 * table is deliberately NOT added — it would count the same detection twice.
 * (A query against a non-existent compliance_events.alert_type column used to
 * sit here; it always failed silently and added 0. Removed, along
 * with the chat count ignoring the report period.)
 */
async function countPiiDetections(startUnix: number): Promise<number> {
  let total = 0;

  total += await getChatFlaggedCount(startUnix);

  try {
    const db = await getTypedClient();
    const rows = await db
      .select({ count: sql<number | string>`count(*)` })
      .from(schema.coworkMessages)
      .where(and(eq(schema.coworkMessages.flagged, 1), gte(schema.coworkMessages.occurred_at, startUnix)));
    total += Number(rows[0]?.count ?? 0);
  } catch { /* table may not exist */ }

  return total;
}

// ─── GDPR Section ─────────────────────────────────────────────────────────

/**
 * Build a GDPR evidence table covering key Art. requirements for the given period.
 */
export async function buildGdprSection(periodStart: string, periodEnd: string): Promise<string> {
  const startUnix = toUnix(periodStart);

  const dpo = await getConfigValue('dataProtectionOfficer');
  const dpiaCompleted = await getConfigValue('dpiaCompleted') === 'true';
  const dpiaDate = await getConfigValue('dpiaDate');
  const retentionDays = await getConfigValue('retentionComplianceDays') || '365';
  const retentionMode = await getConfigValue('retentionMode') || 'strip';
  const archiveEnabled = await getConfigValue('archiveEnabled') === 'true';

  const piiCount = await countPiiDetections(startUnix);

  const dpoStatus = dpo ? dpo : '**Not declared**';

  let dpiaStatus: string;
  if (dpiaCompleted) {
    dpiaStatus = dpiaDate ? `Yes, completed ${dpiaDate}` : 'Yes';
  } else {
    dpiaStatus = '**No**';
  }

  const piiStatus = `${piiCount} detection${piiCount !== 1 ? 's' : ''} in period`;

  const retentionStatus = `${retentionDays} days (mode: ${retentionMode})`;

  const archiveStatus = archiveEnabled ? 'Enabled' : '**Disabled**';

  const rows = [
    ['✔', 'Data Protection Officer', dpoStatus, 'Art. 37'],
    ['✔', 'DPIA conducted', dpiaStatus, 'Art. 35'],
    ['✔', 'Data subject export', 'Available', 'Art. 15/20'],
    ['✔', 'Data subject erasure', 'Available', 'Art. 17'],
    ['✔', 'PII detections', piiStatus, 'Art. 32/Art. 5(1)(f)'],
    ['✔', 'Data retention policy', retentionStatus, 'Art. 5(1)(e)'],
    ['✔', 'Archive before deletion', archiveStatus, 'Art. 5(2)'],
  ];

  const header = '| Check | Status | Evidence | Reference |';
  const divider = '|-------|--------|----------|-----------|';
  const tableRows = rows.map(([check, status, evidence, ref]) =>
    `| ${check} | ${status} | ${evidence} | ${ref} |`
  );

  return [
    '## GDPR Evidence',
    '',
    `> Period: ${periodStart} – ${periodEnd}`,
    '',
    header,
    divider,
    ...tableRows,
  ].join('\n');
}

// ─── LGPD Section ─────────────────────────────────────────────────────────

/**
 * Build an LGPD (Lei 13.709/2018) evidence table for the given period.
 * Deterministic builder — mirrors buildGdprSection; reuses countPiiDetections
 * so GDPR and LGPD report the same PII figure.
 */
export async function buildLgpdSection(periodStart: string, periodEnd: string): Promise<string> {
  const startUnix = toUnix(periodStart);

  const encarregado = await getConfigValue('dataProtectionEncarregado');
  const ripdCompleted = await getConfigValue('ripdCompleted') === 'true';
  const ripdDate = await getConfigValue('ripdDate');
  const retentionDays = await getConfigValue('retentionComplianceDays') || '365';
  const retentionMode = await getConfigValue('retentionMode') || 'strip';
  const archiveEnabled = await getConfigValue('archiveEnabled') === 'true';

  const piiCount = await countPiiDetections(startUnix);

  const encarregadoStatus = encarregado ? encarregado : '**Not declared**';

  let ripdStatus: string;
  if (ripdCompleted) {
    ripdStatus = ripdDate ? `Yes, completed ${ripdDate}` : 'Yes';
  } else {
    ripdStatus = '**No**';
  }

  const piiStatus = `${piiCount} detection${piiCount !== 1 ? 's' : ''} in period`;
  const retentionStatus = `${retentionDays} days (mode: ${retentionMode})`;
  const archiveStatus = archiveEnabled ? 'Enabled' : '**Disabled**';

  const rows = [
    ['✔', 'Encarregado (Data Protection Officer)', encarregadoStatus, 'Art. 41'],
    ['✔', 'RIPD conducted (Relatório de Impacto)', ripdStatus, 'Art. 38'],
    ['✔', 'Titular data export', 'Available', 'Art. 18'],
    ['✔', 'Titular data erasure', 'Available', 'Art. 18'],
    ['✔', 'PII detections', piiStatus, 'Art. 46'],
    ['✔', 'Data retention policy', retentionStatus, 'Arts. 15–16'],
    ['✔', 'Archive before deletion', archiveStatus, 'Art. 37'],
  ];

  const header = '| Check | Status | Evidence | Reference |';
  const divider = '|-------|--------|----------|-----------|';
  const tableRows = rows.map(([check, status, evidence, ref]) =>
    `| ${check} | ${status} | ${evidence} | ${ref} |`
  );

  return [
    '## LGPD Evidence',
    '',
    `> Period: ${periodStart} – ${periodEnd}`,
    '',
    '> Supervisory authority: ANPD.',
    '',
    header,
    divider,
    ...tableRows,
    '',
    '> Breach notification (Art. 48): LGPD requires communication to the ANPD and the data subject within a reasonable time, at the ANPD\'s discretion. This differs from the GDPR\'s fixed statutory deadline.',
  ].join('\n');
}

// ─── EU AI Act Section ────────────────────────────────────────────────────

/**
 * Build an EU AI Act compliance summary (config-based, no period filter).
 */
export async function buildEuAiActSection(): Promise<string> {
  const riskTier = await getConfigValue('aiActRiskTier') || 'not-assessed';
  const transparencyNotice = await getConfigValue('aiActTransparencyNotice') === 'true';
  const organisationName = await getConfigValue('organisationName');
  const acceptableUsePolicy = await getConfigValue('acceptableUsePolicy');

  let aiFeatures = false;
  try {
    aiFeatures = (await getDataSourceStatus()).aiFeatures;
  } catch { /* graceful degradation */ }

  const riskStatus = riskTier === 'not-assessed'
    ? '**Not assessed**'
    : capitalize(riskTier);

  const transparencyStatus = transparencyNotice ? 'Configured' : '**Not configured**';

  const docsConfigured = organisationName && acceptableUsePolicy;
  const docStatus = docsConfigured
    ? 'Organisation name and acceptable-use policy declared'
    : organisationName
      ? 'Organisation name declared, **acceptable-use policy missing**'
      : acceptableUsePolicy
        ? 'Acceptable-use policy declared, **organisation name missing**'
        : '**Neither organisation name nor acceptable-use policy declared**';

  const automatedMonitoringStatus = aiFeatures
    ? 'Active: AI key configured'
    : 'AI features not enabled';

  const rows = [
    ['✔', 'System risk classification', riskStatus, 'Arts. 5/6/50'],
    ['✔', 'Transparency notice', transparencyStatus, 'Art. 50'],
    ['✔', 'Human oversight', 'In place (dashboard + alert system)', 'Art. 14'],
    ['✔', 'System documentation', docStatus, 'Art. 11'],
    ['✔', 'Automated decision monitoring', automatedMonitoringStatus, 'Art. 14'],
  ];

  const header = '| Check | Status | Evidence | Reference |';
  const divider = '|-------|--------|----------|-----------|';
  const tableRows = rows.map(([check, status, evidence, ref]) =>
    `| ${check} | ${status} | ${evidence} | ${ref} |`
  );

  return [
    '## EU AI Act Compliance',
    '',
    '> Regulation (EU) 2024/1689: all declarations are self-assessed unless external audit noted.',
    '',
    header,
    divider,
    ...tableRows,
  ].join('\n');
}

// ─── ISO 27001 Section ────────────────────────────────────────────────────

/**
 * Build an ISO/IEC 27001:2022 control summary for the given period.
 */
export async function buildIso27001Section(periodStart: string, periodEnd: string): Promise<string> {
  const startUnix = toUnix(periodStart);

  const isoOwner = await getConfigValue('isoControlOwner');
  const certStatus = await getConfigValue('isoCertificationStatus') || 'not-started';
  const archiveEnabled = await getConfigValue('archiveEnabled') === 'true';

  // Security incidents
  let alertCounts: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  try {
    alertCounts = await getOpenAlertsBySeverity();
  } catch { /* graceful degradation */ }

  const totalOpen = Object.values(alertCounts).reduce((a, b) => a + b, 0);
  const incidentStatus = `${totalOpen} open (${alertCounts.high ?? 0} high, ${alertCounts.medium ?? 0} medium)`;

  // Access control: OTel users
  let otelUserCount = 0;
  try {
    const db = await getTypedClient();
    const otelRows = await db
      .select({ count: sql<number | string>`count(*)` })
      .from(schema.users)
      .where(eq(schema.users.source, 'otel'));
    otelUserCount = Number(otelRows[0]?.count ?? 0);
  } catch { /* users table may not exist */ }

  const accessControlStatus = otelUserCount > 0
    ? `${otelUserCount} OTel user${otelUserCount !== 1 ? 's' : ''}`
    : 'No OTel users registered';

  // Audit logging — count surfaces with data
  let surfaceData: { chat: number; code: number; agentCowork: number; otelCowork: number } = { chat: 0, code: 0, agentCowork: 0, otelCowork: 0 };
  try {
    // getSurfaceBreakdown is async (converted in queries.ts) — await first.
    surfaceData = await getSurfaceBreakdown();
  } catch { /* graceful degradation */ }

  const surfaces = [];
  if (surfaceData.chat > 0) surfaces.push('Chat');
  if (surfaceData.code > 0) surfaces.push('Code');
  if (surfaceData.agentCowork > 0) surfaces.push('Cowork (Agent)');
  if (surfaceData.otelCowork > 0) surfaces.push('Cowork (OTel)');

  const auditStatus = surfaces.length > 0
    ? `Logging active on ${surfaces.length} surface${surfaces.length !== 1 ? 's' : ''}: ${surfaces.join(', ')}`
    : 'No surface data logged yet';

  // Error monitoring
  let errorCount = 0;
  try {
    const db = await getTypedClient();
    const rows = await db
      .select({ count: sql<number | string>`count(*)` })
      .from(schema.errorEvents)
      .where(gte(schema.errorEvents.occurred_at, startUnix));
    errorCount = Number(rows[0]?.count ?? 0);
  } catch { /* table may not exist */ }

  const ownerStatus = isoOwner ? isoOwner : '**Not declared**';
  const certDisplayStatus = certStatus === 'not-started'
    ? '**Not started**'
    : capitalize(certStatus);
  const archiveStatus = archiveEnabled ? 'Enabled' : '**Disabled**';

  const rows = [
    ['✔', 'ISMS owner', ownerStatus, 'A.5.1'],
    ['✔', 'Certification status', certDisplayStatus, '—'],
    ['✔', 'Security incidents', incidentStatus, 'A.5.24–A.5.28'],
    ['✔', 'Access control', accessControlStatus, 'A.8.2–A.8.5'],
    ['✔', 'Audit logging', auditStatus, 'A.8.15'],
    ['✔', 'Data backup/archive', archiveStatus, 'A.8.13'],
    ['✔', `Error monitoring (${errorCount} events)`, `${errorCount} error event${errorCount !== 1 ? 's' : ''} in period`, 'A.5.24–A.5.28'],
  ];

  const header = '| Check | Control | Evidence | Reference |';
  const divider = '|-------|---------|----------|-----------|';
  const tableRows = rows.map(([check, control, evidence, ref]) =>
    `| ${check} | ${control} | ${evidence} | ${ref} |`
  );

  return [
    '## ISO/IEC 27001:2022 Controls',
    '',
    '> ISO/IEC 27001:2022 annex numbering used throughout (A.5–A.8).',
    '',
    `> Period: ${periodStart} – ${periodEnd}`,
    '',
    header,
    divider,
    ...tableRows,
  ].join('\n');
}

// ─── ISO/IEC 42001:2023 Section ─────────────────────────────────────────

/**
 * Build an ISO/IEC 42001:2023 AI management system control summary.
 */
export async function buildIso42001Section(periodStart: string, periodEnd: string): Promise<string> {
  const startUnix = toUnix(periodStart);

  const aimsOwner = await getConfigValue('iso42001Owner');
  const assessmentStatus = await getConfigValue('iso42001AssessmentStatus') || 'not-started';
  const acceptableUsePolicy = await getConfigValue('acceptableUsePolicy');

  const piiCount = await countPiiDetections(startUnix);

  // Surface tracking
  let surfaceData: { chat: number; code: number; agentCowork: number; otelCowork: number } = { chat: 0, code: 0, agentCowork: 0, otelCowork: 0 };
  try {
    // getSurfaceBreakdown is async (converted in queries.ts) — await first.
    surfaceData = await getSurfaceBreakdown();
  } catch { /* graceful degradation */ }

  const surfacesWithData = [];
  if (surfaceData.chat > 0) surfacesWithData.push('Chat');
  if (surfaceData.code > 0) surfacesWithData.push('Code');
  if (surfaceData.agentCowork > 0) surfacesWithData.push('Cowork (Agent)');
  if (surfaceData.otelCowork > 0) surfacesWithData.push('Cowork (OTel)');

  // Alert system
  let alertCounts: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  try {
    alertCounts = await getOpenAlertsBySeverity();
  } catch { /* graceful degradation */ }

  const totalAlerts = Object.values(alertCounts).reduce((a, b) => a + b, 0);

  const ownerStatus = aimsOwner ? aimsOwner : '**Not declared**';
  const assessmentDisplayStatus = assessmentStatus === 'not-started'
    ? '**Not started**'
    : capitalize(assessmentStatus);
  const policyStatus = acceptableUsePolicy ? 'Declared' : '**Not declared**';
  const inventoryStatus = `${surfacesWithData.length} surface${surfacesWithData.length !== 1 ? 's' : ''} active`;
  const dataQualityStatus = `${PII_PATTERNS.length} detection patterns (${piiCount} detection${piiCount !== 1 ? 's' : ''} in period)`;
  const loggingStatus = surfacesWithData.length > 0
    ? `Active on ${surfacesWithData.join(', ')}`
    : 'No surface data logged';
  const incidentStatus = `${totalAlerts} open alert${totalAlerts !== 1 ? 's' : ''}`;

  const rows = [
    ['✔', 'AIMS owner', ownerStatus, '6.1.2'],
    ['✔', 'Assessment status', assessmentDisplayStatus, '—'],
    ['✔', 'AI objectives (acceptable use policy)', policyStatus, '6.2'],
    ['✔', 'AI system inventory', inventoryStatus, 'A.4.3'],
    ['✔', 'Data quality controls', dataQualityStatus, 'A.7.4'],
    ['✔', 'Sensitive data handling', dataQualityStatus, 'A.7.5'],
    ['✔', 'Logging & monitoring', loggingStatus, 'A.9.3'],
    ['✔', 'Incident management', incidentStatus, 'A.9.4'],
  ];

  const header = '| Check | Control | Evidence | Reference |';
  const divider = '|-------|---------|----------|-----------|';
  const tableRows = rows.map(([check, control, evidence, ref]) =>
    `| ${check} | ${control} | ${evidence} | ${ref} |`
  );

  return [
    '## ISO/IEC 42001:2023 AI Management System',
    '',
    '> ISO/IEC 42001:2023 control numbering used throughout.',
    '',
    `> Period: ${periodStart} – ${periodEnd}`,
    '',
    header,
    divider,
    ...tableRows,
  ].join('\n');
}

// ─── Compliance Gaps ──────────────────────────────────────────────────────

/**
 * Scan config and live data for compliance gaps; return a risk register table.
 * If no gaps are found returns a clean-bill-of-health message.
 */
export async function buildComplianceGaps(): Promise<string> {
  const gaps: Array<{ framework: string; reference: string; gap: string }> = [];

  const gdprApplicable = (await getConfigValue('gdprApplicable') || 'true') === 'true';
  const lgpdApplicable = await getConfigValue('lgpdApplicable') === 'true';

  let piiCount: number | null = null;
  const getPiiCount = async (): Promise<number> => {
    if (piiCount === null) piiCount = await countPiiDetections(0);
    return piiCount;
  };

  // ── GDPR ──
  if (gdprApplicable) {
    const dpiaCompleted = await getConfigValue('dpiaCompleted') === 'true';
    if (!dpiaCompleted) {
      gaps.push({ framework: 'GDPR', reference: 'Art. 35', gap: 'DPIA not recorded as completed' });
    }

    const dpo = await getConfigValue('dataProtectionOfficer');
    if (!dpo) {
      gaps.push({ framework: 'GDPR', reference: 'Art. 37', gap: 'Data Protection Officer not declared' });
    }

    // PII count — use epoch 0 so it covers all time for gap detection
    const gdprPii = await getPiiCount();
    if (gdprPii > 0) {
      gaps.push({
        framework: 'GDPR',
        reference: 'Art. 32',
        gap: `${gdprPii} PII detection${gdprPii !== 1 ? 's' : ''} recorded. Review data handling controls`,
      });
    }

    const archiveEnabled = await getConfigValue('archiveEnabled') === 'true';
    const retentionMode = await getConfigValue('retentionMode');
    if (!archiveEnabled && retentionMode) {
      gaps.push({
        framework: 'GDPR',
        reference: 'Art. 5(2)',
        gap: 'Retention mode is set but archive is disabled, so the accountability chain may be incomplete',
      });
    }
  }

  // ── LGPD ──
  if (lgpdApplicable) {
    const encarregado = await getConfigValue('dataProtectionEncarregado');
    if (!encarregado) {
      gaps.push({ framework: 'LGPD', reference: 'Art. 41', gap: 'Encarregado not declared' });
    }

    const ripdCompleted = await getConfigValue('ripdCompleted') === 'true';
    if (!ripdCompleted) {
      gaps.push({ framework: 'LGPD', reference: 'Art. 38', gap: 'RIPD not recorded as completed' });
    }

    const lgpdPii = await getPiiCount();
    if (lgpdPii > 0) {
      gaps.push({
        framework: 'LGPD',
        reference: 'Art. 46',
        gap: `${lgpdPii} PII detection${lgpdPii !== 1 ? 's' : ''} recorded. Review data handling controls`,
      });
    }
  }

  // ── EU AI Act ──
  const riskTier = await getConfigValue('aiActRiskTier') || 'not-assessed';
  if (riskTier === 'not-assessed') {
    gaps.push({
      framework: 'EU AI Act',
      reference: 'Arts. 5/6/50',
      gap: 'AI system risk tier not assessed',
    });
  }

  const transparencyNotice = await getConfigValue('aiActTransparencyNotice') === 'true';
  if (!transparencyNotice) {
    gaps.push({
      framework: 'EU AI Act',
      reference: 'Art. 50',
      gap: 'Transparency notice not configured',
    });
  }

  // ── ISO 27001 ──
  const isoOwner = await getConfigValue('isoControlOwner');
  if (!isoOwner) {
    gaps.push({
      framework: 'ISO 27001',
      reference: 'A.5.1',
      gap: 'ISMS control owner not declared',
    });
  }

  const certStatus = await getConfigValue('isoCertificationStatus') || 'not-started';
  if (certStatus === 'not-started') {
    gaps.push({
      framework: 'ISO 27001',
      reference: '—',
      gap: 'Certification process not started',
    });
  }

  // ── ISO 42001 ──
  const aimsOwner = await getConfigValue('iso42001Owner');
  if (!aimsOwner) {
    gaps.push({
      framework: 'ISO 42001',
      reference: '6.1.2',
      gap: 'AI Management System owner not declared',
    });
  }

  const aimsStatus = await getConfigValue('iso42001AssessmentStatus') || 'not-started';
  if (aimsStatus === 'not-started') {
    gaps.push({
      framework: 'ISO 42001',
      reference: '—',
      gap: 'Assessment process not started',
    });
  }

  const aup = await getConfigValue('acceptableUsePolicy');
  if (!aup) {
    gaps.push({
      framework: 'ISO 42001',
      reference: '6.2',
      gap: 'AI acceptable use policy not declared',
    });
  }

  if (gaps.length === 0) {
    return 'No compliance gaps identified: all declarations complete and no outstanding issues.';
  }

  const header = '| Framework | Reference | Gap |';
  const divider = '|-----------|-----------|-----|';
  const tableRows = gaps.map(({ framework, reference, gap }) =>
    `| ${framework} | ${reference} | ${gap} |`
  );

  return [
    '## Compliance Gaps',
    '',
    header,
    divider,
    ...tableRows,
  ].join('\n');
}
