// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// A structural test. Asserting the shape of the call site is the only way to
// pin "no model call inside ingest" without standing up a full OTel pipeline
// and timing it, and a timing test would be flaky.
describe('the PII alert path is fire-and-forget', () => {
  for (const f of ['lib/otel/cowork-receiver.ts', 'lib/otel/code-receiver.ts']) {
    it(`${f} does not await firePendingPiiAlert`, () => {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/await\s+firePendingPiiAlert/);
      expect(src).toMatch(/firePendingPiiAlert\([\s\S]{0,200}?\)\s*\.catch\(/);
    });
  }
});
