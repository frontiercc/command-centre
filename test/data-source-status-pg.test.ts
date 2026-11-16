// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The dashboard's data-source list: the Anthropic Compliance API is on when its own key (the
// Compliance access key the sync runs on) is saved, not the Admin API key; OpenAI's source is
// listed, on or off by its key, unless an admin hid ChatGPT and Codex.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let cleanup: () => Promise<void>;
let setConfigValue: typeof import('@/lib/config').setConfigValue;
let getDataSourceStatus: typeof import('@/lib/config').getDataSourceStatus;

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  cleanup = h.cleanup;
  ({ setConfigValue, getDataSourceStatus } = await import('@/lib/config'));
}, 120_000);
afterAll(async () => cleanup?.());

describe('getDataSourceStatus', () => {
  it('reads the Compliance key for the Compliance API, and lists OpenAI as off with no key', async () => {
    await setConfigValue('anthropicAdminApiKey', 'sk-ant-admin-test');
    let s = await getDataSourceStatus();
    expect(s.complianceApi).toBe(false);
    expect(s).toMatchObject({ openai: false, openaiShown: true });

    await setConfigValue('complianceAccessKey', 'sk-ant-compliance-test');
    await setConfigValue('openaiAdminApiKey', 'sk-openai-test');
    s = await getDataSourceStatus();
    expect(s).toMatchObject({ complianceApi: true, openai: true, mode: 'enterprise' });

    await setConfigValue('openaiShown', 'false');
    expect((await getDataSourceStatus()).openaiShown).toBe(false);
  });
});
