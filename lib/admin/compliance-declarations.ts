// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The compliance declaration checklist, in one place: Admin → Compliance
 * counts it and the Admin → Overview tile shows the same count. Client-safe
 * (no server imports).
 */

export interface ComplianceDeclarations {
  dpiaCompleted: boolean;
  dpiaDate: string;
  dataProtectionOfficer: string;
  aiActRiskTier: string;
  aiActTransparencyNotice: boolean;
  isoControlOwner: string;
  isoCertificationStatus: string;
  iso42001Owner: string;
  iso42001AssessmentStatus: string;
  gdprApplicable: boolean;
  lgpdApplicable: boolean;
  dataProtectionEncarregado: string;
  ripdCompleted: boolean;
  ripdDate: string;
}

export interface ComplianceFieldStatus {
  label: string;
  done: boolean;
}

/** One row per field the Compliance page counts; GDPR and LGPD rows only when that law applies. */
export function complianceFieldStatuses(d: ComplianceDeclarations): ComplianceFieldStatus[] {
  return [
    ...(d.gdprApplicable ? [
      { label: 'DPO assigned', done: !!d.dataProtectionOfficer.trim() },
      { label: 'DPIA completed', done: d.dpiaCompleted },
      { label: 'DPIA date set', done: !!(d.dpiaCompleted && d.dpiaDate) },
    ] : []),
    ...(d.lgpdApplicable ? [
      { label: 'Encarregado assigned', done: !!d.dataProtectionEncarregado.trim() },
      { label: 'RIPD completed', done: d.ripdCompleted },
      { label: 'RIPD date set', done: !!(d.ripdCompleted && d.ripdDate) },
    ] : []),
    { label: 'AI Act risk assessed', done: d.aiActRiskTier !== 'not-assessed' },
    { label: 'Transparency notice', done: d.aiActTransparencyNotice },
    { label: 'ISMS control owner', done: !!d.isoControlOwner.trim() },
    { label: 'ISO certification status set', done: d.isoCertificationStatus !== 'not-started' },
    { label: 'AIMS owner', done: !!d.iso42001Owner.trim() },
    { label: 'ISO 42001 assessment set', done: d.iso42001AssessmentStatus !== 'not-started' },
  ];
}

const isTrue = (v: unknown) => v === true || v === 'true';
const text = (v: unknown, fallback = '') => (v === undefined || v === null || v === '' ? fallback : String(v));

/**
 * Reads the declarations from a GET /api/config response with the same
 * defaults the Compliance page starts from (GDPR applies unless switched off,
 * LGPD does not unless switched on).
 */
export function complianceDeclarationsFromConfig(config: Record<string, unknown>): ComplianceDeclarations {
  return {
    dpiaCompleted: isTrue(config.dpiaCompleted),
    dpiaDate: text(config.dpiaDate),
    dataProtectionOfficer: text(config.dataProtectionOfficer),
    aiActRiskTier: text(config.aiActRiskTier, 'not-assessed'),
    aiActTransparencyNotice: isTrue(config.aiActTransparencyNotice),
    isoControlOwner: text(config.isoControlOwner),
    isoCertificationStatus: text(config.isoCertificationStatus, 'not-started'),
    iso42001Owner: text(config.iso42001Owner),
    iso42001AssessmentStatus: text(config.iso42001AssessmentStatus, 'not-started'),
    gdprApplicable: config.gdprApplicable === undefined ? true : isTrue(config.gdprApplicable),
    lgpdApplicable: config.lgpdApplicable === undefined ? false : isTrue(config.lgpdApplicable),
    dataProtectionEncarregado: text(config.dataProtectionEncarregado),
    ripdCompleted: isTrue(config.ripdCompleted),
    ripdDate: text(config.ripdDate),
  };
}
