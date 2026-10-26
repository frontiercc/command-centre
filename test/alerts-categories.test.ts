// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { categoryForType, typesForCategory, ALERT_CATEGORIES } from '@/lib/alerts/categories';

const KNOWN = ['policy','intent','code_repo_exposure','code_model_policy','code_cost_spike','code_friction','adoption','anomaly','pulse_capability','risk','use_case_at_risk','finance_reconciliation_drift'];

describe('alert categories', () => {
  it('maps each known type to exactly one category', () => {
    for (const t of KNOWN) {
      const cat = categoryForType(t);
      expect(cat).not.toBe('other');
      const hits = Object.values(ALERT_CATEGORIES).filter(list => list.includes(t)).length;
      expect(hits).toBe(1); // no type in two categories
    }
  });

  it('maps PII/policy to security-compliance', () => {
    expect(categoryForType('policy')).toBe('security-compliance');
  });

  it('maps risk to security-compliance (no standalone Risk bucket)', () => {
    expect(categoryForType('risk')).toBe('security-compliance');
  });

  it('maps anomaly to security-compliance', () => {
    expect(categoryForType('anomaly')).toBe('security-compliance');
  });

  it('maps use_case_at_risk to adoption-usage', () => {
    expect(categoryForType('use_case_at_risk')).toBe('adoption-usage');
  });

  it('maps finance_reconciliation_drift to cost-efficiency', () => {
    expect(categoryForType('finance_reconciliation_drift')).toBe('cost-efficiency');
  });

  it('unknown type -> other', () => {
    expect(categoryForType('made_up_type')).toBe('other');
    expect(typesForCategory('made_up_category')).toEqual([]);
  });

  it('typesForCategory round-trips', () => {
    expect(typesForCategory('security-compliance').sort()).toEqual(
      ['anomaly', 'code_model_policy', 'code_repo_exposure', 'intent', 'policy', 'risk']
    );
    expect(typesForCategory('cost-efficiency').sort()).toEqual(
      ['code_cost_spike', 'code_friction', 'finance_reconciliation_drift']
    );
    expect(typesForCategory('adoption-usage').sort()).toEqual(
      ['adoption', 'pulse_capability', 'use_case_at_risk']
    );
  });
});
