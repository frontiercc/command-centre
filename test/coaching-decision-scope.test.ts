// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may take a So What decision: an admin for any team and for the cards about the whole
 * organisation, a manager only for their own team. Both So What pages' decision routes use it.
 */
import { describe, it, expect } from 'vitest';
import { decisionScope, EVERYONE } from '@/lib/pulse/coaching-scope';

const TEAMS = ['Finance', 'Legal'];

describe('decisionScope', () => {
  it('lets an admin decide for a team and for the whole organisation', () => {
    expect(decisionScope({ role: 'admin' }, TEAMS, 'Legal')).toEqual({ ok: true });
    expect(decisionScope({ role: 'admin' }, TEAMS, EVERYONE)).toEqual({ ok: true });
  });

  it('refuses an admin a team that is not there', () => {
    expect(decisionScope({ role: 'admin' }, TEAMS, 'Marketing')).toEqual({ error: 'You can only decide for your own team.' });
  });

  it('lets a manager decide only for their own team, never for the whole organisation', () => {
    expect(decisionScope({ role: 'manager', department: 'Finance' }, TEAMS, 'Finance')).toEqual({ ok: true });
    expect(decisionScope({ role: 'manager', department: 'Finance' }, TEAMS, 'Legal')).toEqual({ error: 'You can only decide for your own team.' });
    expect(decisionScope({ role: 'manager', department: 'Finance' }, TEAMS, EVERYONE)).toEqual({ error: 'You can only decide for your own team.' });
  });

  it('refuses a manager with no department, saying why', () => {
    const r = decisionScope({ role: 'manager', department: null }, TEAMS, 'Finance');
    expect('error' in r && r.error).toMatch(/no department/);
  });
});
