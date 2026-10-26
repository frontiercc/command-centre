// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

const configValues: Record<string, string> = {};

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn(async (key: string) => configValues[key] ?? ''),
  getDataSourceStatus: vi.fn(async () => ({ aiFeatures: false })),
}));
vi.mock('@/lib/db/client', () => ({
  getTypedClient: vi.fn(async () => { throw new Error('no db in test'); }),
}));
vi.mock('@/lib/db/queries', () => ({
  getChatFlaggedCount: vi.fn(async () => 0),
  getOpenAlertsBySeverity: vi.fn(async () => ({ low: 0, medium: 0, high: 0, critical: 0 })),
  getSurfaceBreakdown: vi.fn(async () => ({ chat: 0, code: 0, agentCowork: 0, otelCowork: 0 })),
}));

import { buildLgpdSection, buildComplianceGaps, buildIso42001Section } from '@/lib/reports/compliance-sections';
import { PII_PATTERNS } from '@/lib/pii/detect';

beforeEach(() => {
  for (const k of Object.keys(configValues)) delete configValues[k];
});

describe('buildLgpdSection', () => {
  it('renders the Encarregado, RIPD, titular rights, retention and PII rows with LGPD article refs', async () => {
    configValues['dataProtectionEncarregado'] = 'João Silva, joao@example.com';
    configValues['ripdCompleted'] = 'true';
    configValues['ripdDate'] = '2026-05-01';
    const out = await buildLgpdSection('2026-07-01', '2026-07-31');
    expect(out).toContain('## LGPD Evidence');
    expect(out).toContain('João Silva');
    expect(out).toContain('Art. 41');
    expect(out).toContain('Art. 38');
    expect(out).toContain('Art. 18');
    expect(out).toContain('Arts. 15–16');
  });
  it('marks missing declarations as Not declared', async () => {
    const out = await buildLgpdSection('2026-07-01', '2026-07-31');
    expect(out).toContain('**Not declared**');
    expect(out).toContain('**No**');
  });
  it('states the Art. 48 breach position without implying a 72-hour deadline', async () => {
    const out = await buildLgpdSection('2026-07-01', '2026-07-31');
    expect(out).toContain('Art. 48');
    expect(out).toMatch(/reasonable time/i);
    expect(out).not.toMatch(/72[- ]hour/i);
  });
});

describe('buildComplianceGaps — framework applicability', () => {
  it('raises NO GDPR gaps when gdprApplicable is false', async () => {
    configValues['gdprApplicable'] = 'false';
    const out = await buildComplianceGaps();
    expect(out).not.toContain('Data Protection Officer not declared');
    expect(out).not.toContain('DPIA not recorded');
  });
  it('raises GDPR gaps when gdprApplicable is unset (defaults applicable — existing behaviour)', async () => {
    const out = await buildComplianceGaps();
    expect(out).toContain('Data Protection Officer not declared');
  });
  it('raises LGPD gaps only when lgpdApplicable is true', async () => {
    let out = await buildComplianceGaps();
    expect(out).not.toContain('Encarregado');
    configValues['lgpdApplicable'] = 'true';
    out = await buildComplianceGaps();
    expect(out).toContain('Encarregado not declared');
    expect(out).toContain('RIPD not recorded as completed');
  });
});

describe('buildIso42001Section — pattern count is derived, never a literal', () => {
  it('reports PII_PATTERNS.length', async () => {
    const out = await buildIso42001Section('2026-07-01', '2026-07-31');
    expect(out).toContain(`${PII_PATTERNS.length} detection patterns`);
    // The stale hardcoded literal must be gone (pattern count is now 20).
    expect(PII_PATTERNS.length).not.toBe(17);
    expect(out).not.toContain('17 detection patterns');
  });
});
