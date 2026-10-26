// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Code kinds of work: labels restate the rubric's own definition; a kind an admin
// adds, or a default whose definition an admin has rewritten, keeps its own name.
import { describe, it, expect } from 'vitest';
import { codeWorkTypeLabel, codeWorkTypeDefinition } from '@/lib/pulse/code/work-type-labels';
import { DEFAULT_CODE_CLASSIFIER_CONFIG } from '@/lib/pulse/code/classifier-prompt';

describe('Code kind-of-work labels', () => {
  it('gives every default kind a plain label and its rubric definition', () => {
    expect(codeWorkTypeLabel('infrastructure')).toBe('Build, deploy and tooling');
    expect(codeWorkTypeDefinition('infrastructure')).toBe('CI/CD, build, deploy, config, tooling');
    expect(codeWorkTypeLabel('exploration')).toBe('Understanding and reviewing code');
    for (const w of DEFAULT_CODE_CLASSIFIER_CONFIG.workTypes) {
      expect(codeWorkTypeLabel(w.name)).not.toBe(w.name);
      expect(codeWorkTypeDefinition(w.name)).toBe(w.description);
    }
  });

  it('keeps the label while the configured definition is unchanged', () => {
    expect(codeWorkTypeLabel('infrastructure', 'CI/CD, build, deploy, config, tooling')).toBe('Build, deploy and tooling');
  });

  it('falls back to the stored name when an admin has rewritten the definition or added a kind', () => {
    expect(codeWorkTypeLabel('infrastructure', 'cloud cost tuning')).toBe('Infrastructure');
    expect(codeWorkTypeDefinition('infrastructure', 'cloud cost tuning')).toBe('cloud cost tuning');
    expect(codeWorkTypeLabel('data_migration')).toBe('Data Migration');
    expect(codeWorkTypeDefinition('data_migration')).toBeNull();
  });
});
