// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  tidyDepartment, departmentKey, parseDepartmentMap, DepartmentResolver, decideDepartment, normaliseEmails,
} from '@/lib/directory/department-rules';

describe('tidyDepartment', () => {
  it('trims and collapses spaces, and gives empty for nothing', () => {
    expect(tidyDepartment('  Platform   Engineering ')).toBe('Platform Engineering');
    expect(tidyDepartment(null)).toBe('');
    expect(tidyDepartment('   ')).toBe('');
    expect(departmentKey(' ENGINEERING ')).toBe('engineering');
  });
});

describe('parseDepartmentMap', () => {
  it('keeps string pairs, tidied, and drops anything else', () => {
    expect(parseDepartmentMap('{" Eng ":"Engineering","x":3,"":"A","Ops":" "}')).toEqual({ Eng: 'Engineering' });
  });
  it('treats malformed or non-object JSON as no map', () => {
    expect(parseDepartmentMap('not json')).toEqual({});
    expect(parseDepartmentMap('["Eng"]')).toEqual({});
    expect(parseDepartmentMap('')).toEqual({});
  });
});

describe('DepartmentResolver', () => {
  it('matches an existing department regardless of capitals and spacing, keeping its spelling', () => {
    const r = new DepartmentResolver(['Engineering', 'Finance'], {});
    expect(r.resolve('  engineering ')).toEqual({ department: 'Engineering', matchedBy: 'existing' });
  });

  it('uses the name map first, matched regardless of capitals, landing on the existing spelling', () => {
    const r = new DepartmentResolver(['Engineering'], { Eng: 'engineering' });
    expect(r.resolve('ENG')).toEqual({ department: 'Engineering', matchedBy: 'map' });
  });

  it('makes a new department from a name that matches nothing, tidied', () => {
    const r = new DepartmentResolver(['Engineering'], {});
    expect(r.resolve(' Platform  Engineering')).toEqual({ department: 'Platform Engineering', matchedBy: 'new' });
  });

  it('lands the same new name, in any spelling, on one department within a run', () => {
    const r = new DepartmentResolver([], {});
    expect(r.resolve('Data')?.department).toBe('Data');
    expect(r.resolve('DATA ')).toEqual({ department: 'Data', matchedBy: 'existing' });
  });

  it('returns null for an empty directory value', () => {
    expect(new DepartmentResolver(['Engineering'], {}).resolve('  ')).toBeNull();
    expect(new DepartmentResolver(['Engineering'], {}).resolve(null)).toBeNull();
  });
});

describe('decideDepartment', () => {
  const eng = { department: 'Engineering', matchedBy: 'existing' as const };

  it('never changes a department set by hand', () => {
    expect(decideDepartment({ current: 'Finance', sources: ['manual', null] }, eng)).toEqual({ action: 'skip', reason: 'manual' });
  });

  it('never changes anything when the directory value is empty', () => {
    expect(decideDepartment({ current: 'Finance', sources: [null] }, null)).toEqual({ action: 'skip', reason: 'empty' });
  });

  it('reports unchanged when the department already matches', () => {
    expect(decideDepartment({ current: 'Engineering', sources: [null] }, eng)).toEqual({ action: 'unchanged', department: 'Engineering' });
  });

  it('fills a blank, which is not a move', () => {
    expect(decideDepartment({ current: null, sources: [null] }, eng)).toEqual({ action: 'change', department: 'Engineering', isMove: false });
  });

  it("treats the directory's first change to a guessed department as a correction, not a move", () => {
    expect(decideDepartment({ current: 'Ops', sources: [null] }, eng)).toEqual({ action: 'change', department: 'Engineering', isMove: false });
  });

  it('treats a later directory change between real departments as a move', () => {
    expect(decideDepartment({ current: 'Finance', sources: ['directory'] }, eng)).toEqual({ action: 'change', department: 'Engineering', isMove: true });
  });
});

describe('normaliseEmails', () => {
  it('lower-cases, strips smtp: prefixes, drops non-addresses and duplicates', () => {
    expect(normaliseEmails(['Dana@Example.com', 'SMTP:dana@example.com', 'smtp:d.p@example.co.uk', null, 'not-an-address']))
      .toEqual(['dana@example.com', 'd.p@example.co.uk']);
  });
});
