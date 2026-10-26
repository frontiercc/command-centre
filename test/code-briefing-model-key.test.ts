// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { CONFIG_KEYS } from '@/lib/config';
import fs from 'node:fs';

describe('codeBriefingModel config key', () => {
  it('is registered in the config key map', () => {
    expect(CONFIG_KEYS.codeBriefingModel).toBe('code_briefing_model');
  });
  it('is allowlisted for saving via /api/config', () => {
    const src = fs.readFileSync('app/api/config/route.ts', 'utf8');
    expect(src).toContain("'codeBriefingModel'");
  });
});
