// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { CONFIG_KEYS } from '@/lib/config';

describe('code_classifier_config key', () => {
  it('is registered in CONFIG_KEYS', () => {
    expect((CONFIG_KEYS as Record<string, string>).codeClassifierConfig).toBe('code_classifier_config');
  });
});
