// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

describe('Risk scoring configuration', () => {
  let cleanup: () => Promise<void>;
  let sql: TestSql;

  beforeAll(async () => {
    const ctx = await createTestDatabase();
    cleanup = ctx.cleanup;
    sql = ctx.sql;
  });

  afterAll(async () => cleanup?.());

  describe('buildAnomalySystemPrompt', () => {
    it('interpolates default threshold values', async () => {
      vi.resetModules();
      const { buildAnomalySystemPrompt } = await import('@/lib/anthropic/ai');

      const prompt = await buildAnomalySystemPrompt();

      // Default values should appear in prompt
      expect(prompt).toContain('3x or more above');
      expect(prompt).toContain('more than 14 days');
      expect(prompt).toContain('more than 50 files');
      expect(prompt).toContain('anomaly, policy, adoption, risk');
    });

    it('uses custom thresholds from config', async () => {
      vi.resetModules();
      const { saveConfig } = await import('@/lib/config');
      const { buildAnomalySystemPrompt } = await import('@/lib/anthropic/ai');

      await saveConfig({
        riskTokenMultiplier: '5',
        riskFileAccessLimit: '100',
        riskInactivityDays: '21',
      });

      const prompt = await buildAnomalySystemPrompt();

      expect(prompt).toContain('5x or more above');
      expect(prompt).toContain('more than 21 days');
      expect(prompt).toContain('more than 100 files');
    });

    it('applies conservative sensitivity multiplier', async () => {
      vi.resetModules();
      const { saveConfig } = await import('@/lib/config');
      const { buildAnomalySystemPrompt } = await import('@/lib/anthropic/ai');

      await saveConfig({
        riskTokenMultiplier: '4',
        riskFileAccessLimit: '50',
        riskInactivityDays: '14',
        riskSensitivity: 'conservative',
      });

      const prompt = await buildAnomalySystemPrompt();

      // 4 * 1.5 = 6, 50 * 1.5 = 75, 14 * 1.5 = 21
      expect(prompt).toContain('6x or more above');
      expect(prompt).toContain('more than 75 files');
      expect(prompt).toContain('more than 21 days');
    });

    it('applies aggressive sensitivity multiplier', async () => {
      vi.resetModules();
      const { saveConfig } = await import('@/lib/config');
      const { buildAnomalySystemPrompt } = await import('@/lib/anthropic/ai');

      await saveConfig({
        riskTokenMultiplier: '5',
        riskFileAccessLimit: '50',
        riskInactivityDays: '14',
        riskSensitivity: 'aggressive',
      });

      const prompt = await buildAnomalySystemPrompt();

      // 5 * 0.6 = 3, 50 * 0.6 = 30, 14 * 0.6 = 8 (rounded)
      expect(prompt).toContain('3x or more above');
      expect(prompt).toContain('more than 30 files');
      expect(prompt).toContain('more than 8 days');
    });

    it('restricts enabled alert types in prompt', async () => {
      vi.resetModules();
      const { saveConfig } = await import('@/lib/config');
      const { buildAnomalySystemPrompt } = await import('@/lib/anthropic/ai');

      await saveConfig({
        riskAlertAnomalyEnabled: 'true',
        riskAlertPolicyEnabled: 'false',
        riskAlertAdoptionEnabled: 'false',
        riskAlertRiskEnabled: 'true',
      });

      const prompt = await buildAnomalySystemPrompt();

      expect(prompt).toContain('ENABLED ALERT TYPES: Only generate alerts of these types: anomaly, risk.');
      // The enabled types line should not include policy or adoption
      const enabledLine = prompt.split('\n').find(l => l.includes('ENABLED ALERT TYPES'));
      expect(enabledLine).not.toContain('policy');
      expect(enabledLine).not.toContain('adoption');
    });

    it('uses custom severity descriptions', async () => {
      vi.resetModules();
      const { saveConfig } = await import('@/lib/config');
      const { buildAnomalySystemPrompt } = await import('@/lib/anthropic/ai');

      await saveConfig({
        riskSeverityLowDesc: 'Custom low description',
        riskSeverityCriticalDesc: 'Custom critical description',
      });

      const prompt = await buildAnomalySystemPrompt();

      expect(prompt).toContain('Custom low description');
      expect(prompt).toContain('Custom critical description');
    });
  });

  describe('Config validation', () => {
    it('getAllConfig returns correct defaults for risk keys', async () => {
      vi.resetModules();
      // Clear any previously saved risk config
      await sql.run("DELETE FROM config WHERE key LIKE 'risk_%'");

      vi.resetModules();
      const { getAllConfig } = await import('@/lib/config');
      const config = await getAllConfig();

      expect(config.riskTokenMultiplier).toBe(3);
      expect(config.riskFileAccessLimit).toBe(50);
      expect(config.riskInactivityDays).toBe(14);
      expect(config.riskSensitivity).toBe('balanced');
      expect(config.riskAlertAnomalyEnabled).toBe(true);
      expect(config.riskAlertPolicyEnabled).toBe(true);
      expect(config.riskAlertAdoptionEnabled).toBe(true);
      expect(config.riskAlertRiskEnabled).toBe(true);
    });

    it('persists and retrieves custom risk values', async () => {
      vi.resetModules();
      const { saveConfig, getAllConfig } = await import('@/lib/config');

      await saveConfig({
        riskTokenMultiplier: '7',
        riskSensitivity: 'aggressive',
        riskAlertPolicyEnabled: 'false',
      });

      const config = await getAllConfig();
      expect(config.riskTokenMultiplier).toBe(7);
      expect(config.riskSensitivity).toBe('aggressive');
      expect(config.riskAlertPolicyEnabled).toBe(false);
    });
  });
});
