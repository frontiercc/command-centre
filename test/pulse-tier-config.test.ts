// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';

describe('Pulse tier configuration', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createTestDatabase();
    cleanup = ctx.cleanup;
  });

  afterAll(async () => cleanup?.());

  describe('getTierConfig', () => {
    it('returns defaults when nothing stored in DB', async () => {
      vi.resetModules();
      const { getTierConfig, DEFAULT_TIER_CONFIG } = await import('@/lib/pulse/tier-config');
      const config = await getTierConfig();
      expect(config.tiers.tier1.name).toBe(DEFAULT_TIER_CONFIG.tiers.tier1.name);
      expect(config.taxonomy.tier1).toHaveLength(DEFAULT_TIER_CONFIG.taxonomy.tier1.length);
      expect(config.confidenceThreshold).toBe(0.7);
    });

    it('reads custom config from DB', async () => {
      vi.resetModules();
      const { saveConfig } = await import('@/lib/config');
      const { getTierConfig } = await import('@/lib/pulse/tier-config');

      const customConfig = {
        tiers: {
          tier1: { name: 'Basic', description: 'Custom tier 1 description' },
          tier2: { name: 'Advanced', description: 'Custom tier 2 description' },
          tier3: { name: 'Expert', description: 'Custom tier 3 description' },
        },
        taxonomy: {
          tier1: [{ name: 'test_task', description: 'a test task type' }],
          tier2: [],
          tier3: [],
        },
        frontierPushCriteria: 'Custom frontier criteria',
        capabilityCreationCriteria: 'Custom capability criteria',
        confidenceThreshold: 0.8,
      };
      await saveConfig({ pulseClassifierConfig: JSON.stringify(customConfig) });

      const config = await getTierConfig();
      expect(config.tiers.tier1.name).toBe('Basic');
      expect(config.taxonomy.tier1[0].name).toBe('test_task');
      expect(config.confidenceThreshold).toBe(0.8);
    });

    it('falls back to defaults on malformed JSON', async () => {
      vi.resetModules();
      const { saveConfig } = await import('@/lib/config');
      const { getTierConfig, DEFAULT_TIER_CONFIG } = await import('@/lib/pulse/tier-config');

      await saveConfig({ pulseClassifierConfig: 'not-valid-json{{{' });

      const config = await getTierConfig();
      expect(config.tiers.tier1.name).toBe(DEFAULT_TIER_CONFIG.tiers.tier1.name);
    });
  });

  describe('buildClassifierSystemMessage', () => {
    it('includes tier names in the prompt', async () => {
      vi.resetModules();
      const { getTypedClient } = await import('@/lib/db/client');
      const { schema } = await import('@/lib/db/schema');
      const { eq } = await import('drizzle-orm');
      const client = await getTypedClient();
      await client.delete(schema.config).where(eq(schema.config.key, 'pulse_classifier_config'));

      vi.resetModules();
      const { buildClassifierSystemMessage, getTierConfig, DEFAULT_TIER_CONFIG } = await import('@/lib/pulse/tier-config');

      const prompt = buildClassifierSystemMessage(await getTierConfig());
      expect(prompt).toContain(DEFAULT_TIER_CONFIG.tiers.tier1.name);
      expect(prompt).toContain(DEFAULT_TIER_CONFIG.tiers.tier3.name);
    });

    it('uses custom tier names when config is stored', async () => {
      vi.resetModules();
      const { saveConfig } = await import('@/lib/config');
      const { getTierConfig } = await import('@/lib/pulse/tier-config');

      const custom = await getTierConfig();
      custom.tiers.tier1.name = 'Routine';
      await saveConfig({ pulseClassifierConfig: JSON.stringify(custom) });

      vi.resetModules();
      const { buildClassifierSystemMessage: build2, getTierConfig: getTierConfig2 } = await import('@/lib/pulse/tier-config');
      const prompt = build2(await getTierConfig2());
      expect(prompt).toContain('Routine');
    });

    it('includes confidence threshold in the prompt', async () => {
      vi.resetModules();
      const { getTypedClient } = await import('@/lib/db/client');
      const { schema } = await import('@/lib/db/schema');
      const { eq } = await import('drizzle-orm');
      const client = await getTypedClient();
      await client.delete(schema.config).where(eq(schema.config.key, 'pulse_classifier_config'));
      vi.resetModules();
      const { buildClassifierSystemMessage, getTierConfig } = await import('@/lib/pulse/tier-config');
      const prompt = buildClassifierSystemMessage(await getTierConfig());
      expect(prompt).toContain('0.7');
    });

    it('includes all default taxonomy task types', async () => {
      vi.resetModules();
      const { getTypedClient } = await import('@/lib/db/client');
      const { schema } = await import('@/lib/db/schema');
      const { eq } = await import('drizzle-orm');
      const client = await getTypedClient();
      await client.delete(schema.config).where(eq(schema.config.key, 'pulse_classifier_config'));
      vi.resetModules();
      const { buildClassifierSystemMessage, getTierConfig } = await import('@/lib/pulse/tier-config');
      const prompt = buildClassifierSystemMessage(await getTierConfig());
      expect(prompt).toContain('summarisation');
      expect(prompt).toContain('autonomous_workflow');
      expect(prompt).toContain('capability_creation');
    });
  });
});
