// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { describeDraftFailure, DRAFT_FAILURE_MESSAGE, shouldDeleteAfterCancel } from '@/components/usecases/SkillDraftPanel';

describe('describeDraftFailure (panel wording, never raw reasons)', () => {
  it("shows the single message whatever the validator said", () => {
    expect(describeDraftFailure(['number or unit "12%" does not appear in the prompts'])).toBe(DRAFT_FAILURE_MESSAGE);
    expect(describeDraftFailure([])).toBe(DRAFT_FAILURE_MESSAGE);
  });
  it('never leaks a reason string', () => {
    const msg = describeDraftFailure(['missing or misordered sections: Steps', 'system "jira" is not in this use case evidence']);
    expect(msg).not.toContain('Steps');
    expect(msg).not.toContain('jira');
  });
});

describe('shouldDeleteAfterCancel (cancel-poll identity check)', () => {
  const startedAt = 1000;
  const cancelledAt = 1010;
  const nowS = 1020;

  it('deletes an undownloaded, unedited draft generated inside the cancelled window', () => {
    expect(shouldDeleteAfterCancel({ generatedAt: 1005, downloadedAt: null, editedAt: null }, startedAt, cancelledAt, nowS)).toBe(true);
  });

  it('never deletes a downloaded draft', () => {
    expect(shouldDeleteAfterCancel({ generatedAt: 1005, downloadedAt: 1006, editedAt: null }, startedAt, cancelledAt, nowS)).toBe(false);
  });

  it('never deletes an edited draft — an edit is deliberate', () => {
    expect(shouldDeleteAfterCancel({ generatedAt: 1005, downloadedAt: null, editedAt: 1007 }, startedAt, cancelledAt, nowS)).toBe(false);
  });

  it('rejects a draft generated before this attempt started', () => {
    expect(shouldDeleteAfterCancel({ generatedAt: startedAt - 6, downloadedAt: null, editedAt: null }, startedAt, cancelledAt, nowS)).toBe(false);
  });

  it('rejects a draft generated after the post-cancel grace window — a later, deliberate draft', () => {
    expect(shouldDeleteAfterCancel({ generatedAt: cancelledAt + 181, downloadedAt: null, editedAt: null }, startedAt, cancelledAt, nowS)).toBe(false);
  });
});
