// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

export type AlertCategory = 'security-compliance' | 'cost-efficiency' | 'adoption-usage' | 'other';

export const CATEGORY_LABELS: Record<AlertCategory, string> = {
  'security-compliance': 'Security, Compliance & Risk',
  'cost-efficiency': 'Cost & Efficiency',
  'adoption-usage': 'Adoption & Use Cases',
  'other': 'Other',
};

export const ALERT_CATEGORIES: Record<Exclude<AlertCategory, 'other'>, string[]> = {
  'security-compliance': ['policy', 'intent', 'code_repo_exposure', 'code_model_policy', 'risk', 'anomaly'],
  'cost-efficiency': ['code_cost_spike', 'code_friction', 'finance_reconciliation_drift'],
  'adoption-usage': ['adoption', 'pulse_capability', 'use_case_at_risk'],
};

export const ALL_CATEGORIES: AlertCategory[] = ['security-compliance', 'cost-efficiency', 'adoption-usage'];

export function categoryForType(type: string): AlertCategory {
  for (const [cat, types] of Object.entries(ALERT_CATEGORIES)) {
    if (types.includes(type)) return cat as AlertCategory;
  }
  return 'other';
}

export function typesForCategory(cat: string): string[] {
  return (ALERT_CATEGORIES as Record<string, string[]>)[cat] ?? [];
}
