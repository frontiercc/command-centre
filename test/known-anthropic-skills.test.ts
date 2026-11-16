// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { isKnownAnthropicSkill, anthropicSkillDescription, anthropicSkillDescriptionEntries, KNOWN_ANTHROPIC_SKILLS } from '@/lib/library/known-anthropic-skills';

describe('isKnownAnthropicSkill', () => {
  it('recognises bare Anthropic skill names', () => {
    expect(isKnownAnthropicSkill('docx')).toBe(true);
    expect(isKnownAnthropicSkill('xlsx')).toBe(true);
  });

  it('recognises the anthropic-skills: namespaced form of the same names', () => {
    // Confirmed on a production deployment: 'xlsx' and 'anthropic-skills:xlsx' arrived as
    // two distinct skill_library_entries rows for the same real skill.
    expect(isKnownAnthropicSkill('anthropic-skills:docx')).toBe(true);
    expect(isKnownAnthropicSkill('anthropic-skills:xlsx')).toBe(true);
  });

  it('does not flag generic/collision-risky names, even ones Anthropic also ships', () => {
    expect(isKnownAnthropicSkill('start')).toBe(false);
    expect(isKnownAnthropicSkill('run')).toBe(false);
    expect(isKnownAnthropicSkill('review')).toBe(false);
    expect(isKnownAnthropicSkill('implement')).toBe(false);
  });

  it('does not flag genuine org-built skill names', () => {
    expect(isKnownAnthropicSkill('board-adapter')).toBe(false);
    expect(isKnownAnthropicSkill('email-checker')).toBe(false);
  });
});

describe('anthropicSkillDescription', () => {
  it('gives the same description for the bare and namespaced name', () => {
    expect(anthropicSkillDescription('internal-comms')).toContain('internal communications');
    expect(anthropicSkillDescription('anthropic-skills:internal-comms')).toBe(anthropicSkillDescription('internal-comms'));
  });

  it('has none for a skill with no published source, rather than a guess', () => {
    for (const name of ['meeting-notes', 'humanize', 'consolidate-memory', 'senior-pitch-writing', 'setup-cowork']) {
      expect(anthropicSkillDescription(name)).toBeNull();
    }
    expect(anthropicSkillDescription('writing-plans')).toBeNull();
  });

  it('describes only known Anthropic skills, in plain text with no em dashes', () => {
    for (const [name, d] of anthropicSkillDescriptionEntries()) {
      expect(KNOWN_ANTHROPIC_SKILLS.has(name)).toBe(true);
      expect(d).not.toContain('—');
      expect(d.length).toBeGreaterThan(0);
    }
  });
});
