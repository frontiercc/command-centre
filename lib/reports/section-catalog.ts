// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for the report section list.
//
// This list previously existed only as a local const in app/reports/page.tsx,
// while the generator carried its own parallel set of `include('id')` string
// checks. Adding sections across two files that must agree is how drift starts,
// so the catalog now lives here and both sides read it.
//
// CLIENT-SAFE: pure data, no imports. app/reports/page.tsx is a client
// component — do not add server-only imports to this module.

export type SectionGate = 'chargebackEnabled' | 'useCasesEnabled' | 'gdprApplicable' | 'lgpdApplicable' | 'humanTimeEnabled';

export interface ReportSectionDef {
  id: string;
  label: string;
  description: string;
  /** Ticked by default in the picker. */
  default: boolean;
  /** Config flag that must be truthy for this section to be offered at all. */
  requiresFlag?: SectionGate;
  /** Restricted to admin|manager — per-cost data is salary-adjacent. */
  managerOnly?: boolean;
}

export const REPORT_SECTIONS: ReportSectionDef[] = [
  { id: 'executive_summary', label: 'Executive Summary', description: 'High-level compliance posture overview', default: true },
  { id: 'data_sources', label: 'Data Sources', description: 'Agent, API, and surface coverage status', default: true },
  { id: 'usage', label: 'Usage by Surface', description: 'Chat / Code / Cowork usage with trends', default: true },
  { id: 'adoption', label: 'Adoption Status', description: 'Active seats, department breakdown', default: true },
  { id: 'gdpr', label: 'GDPR Compliance', description: 'Data protection impact, retention, access rights', default: true, requiresFlag: 'gdprApplicable' },
  { id: 'lgpd', label: 'LGPD Compliance', description: 'Brazilian data protection: Encarregado, RIPD, titular rights, retention', default: false, requiresFlag: 'lgpdApplicable' },
  { id: 'eu_ai_act', label: 'EU AI Act', description: 'Risk tier, transparency notices', default: false },
  { id: 'iso_27001', label: 'ISO 27001', description: 'Information security controls', default: false },
  { id: 'iso_42001', label: 'ISO/IEC 42001:2023', description: 'AI management system controls', default: false },
  { id: 'alerts', label: 'Alerts Summary', description: 'Open, resolved, dismissed alerts in period', default: true },
  { id: 'cowork_audit', label: 'Cowork Audit', description: 'Full conversation capture coverage', default: true },
  { id: 'cowork_activity', label: 'Cowork Activity', description: 'Projects, files touched, and session metrics', default: false },
  { id: 'code_audit', label: 'Code Audit', description: 'Claude Code session activity and tool usage', default: true },
  { id: 'chat_audit', label: 'Chat Audit', description: 'Claude Desktop chat prompt capture coverage', default: true },
  { id: 'compliance_gaps', label: 'Compliance Gaps', description: 'Missing declarations and actions needed', default: true },
  { id: 'recommendations', label: 'Recommendations', description: 'Suggested actions for next period', default: true },

  // ── Analytics sections ──────────────────────────────────────────────────
  // Everything below reports on data the platform already computes; none of it
  // requires new capture. Each is off by default so existing report habits are
  // unchanged until someone opts in.
  {
    id: 'finops',
    label: 'Cost & Chargeback',
    description: 'Spend by surface and cost centre, model efficiency, pricing caveats',
    default: false,
    requiresFlag: 'chargebackEnabled',
    managerOnly: true,
  },
  {
    id: 'spend_review',
    label: 'Spend Review',
    description: 'Biggest spenders, better routes for each, most efficient people, Anthropic limits',
    default: false,
    requiresFlag: 'chargebackEnabled',
    managerOnly: true,
  },
  {
    id: 'code_pulse',
    label: 'Developer Pulse',
    description: 'Engaged time, shipping, spend, autonomy, work mix and friction',
    default: false,
  },
  {
    id: 'cowork_pulse',
    label: 'Work Pulse',
    description: 'Delegation depth, task types, tier mix and emerging capability',
    default: false,
  },
  {
    id: 'sc_board',
    label: 'Skills & Connectors',
    description: 'Tools in use, ownership gaps, spread and key-person risk',
    default: false,
  },
  {
    id: 'use_cases',
    label: 'Use Cases',
    description: 'Registered use cases found in the period, live or not seen',
    default: false,
    requiresFlag: 'useCasesEnabled',
  },
  {
    id: 'human_time',
    label: 'Human time vs Claude time',
    description: 'By-hand estimate against measured Claude time, Code and Cowork',
    default: false,
    requiresFlag: 'humanTimeEnabled',
  },
];

/** Section ids that survive the current flags and role. */
export function availableSections(
  flags: Partial<Record<SectionGate, boolean>>,
  canSeeManagerOnly: boolean,
): ReportSectionDef[] {
  return REPORT_SECTIONS.filter(s => {
    if (s.requiresFlag && !flags[s.requiresFlag]) return false;
    if (s.managerOnly && !canSeeManagerOnly) return false;
    return true;
  });
}
