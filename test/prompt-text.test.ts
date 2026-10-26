// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { cleanPromptText, stripIdentity, SCHEDULED_TASK_PREAMBLE } from '@/lib/usecases/prompt-text';

describe('cleanPromptText', () => {
  it('drops Cowork\'s system text and keeps the person\'s words', () => {
    const raw = '<system-reminder>This session can reach the device "laptop" via device_list_dir. Folder access is pending.</system-reminder>\n\ndraft the month-end variance commentary';
    expect(cleanPromptText(raw)).toBe('draft the month-end variance commentary');
  });

  it('turns a scheduled task into its name plus its own instructions, without the shared preamble', () => {
    const raw = `<scheduled-task name="global-accounts-weekly-forecast" file="/Users/someone/tasks/x.md">\n${SCHEDULED_TASK_PREAMBLE}\n\nBuild the weekly forecast from Salesforce.\n</scheduled-task>`;
    expect(cleanPromptText(raw)).toBe('Scheduled task: global-accounts-weekly-forecast. Build the weekly forecast from Salesforce.');
  });

  it('removes artifact-view, uploaded-files and task-notification wrappers', () => {
    expect(cleanPromptText('<artifact-view-context>state dump</artifact-view-context> make the header blue')).toBe('make the header blue');
    expect(cleanPromptText('<uploaded_files>a.xlsx b.pdf</uploaded_files> summarise these')).toBe('summarise these');
    expect(cleanPromptText('<task-notification>done</task-notification> next step please')).toBe('next step please');
  });

  it('drops a wrapper that was opened and cut off by the storage cap', () => {
    expect(cleanPromptText('check the totals <system-reminder>This session can reach the device and then the text was cut')).toBe('check the totals');
  });

  it('returns empty for a redacted prompt or one that was only a wrapper', () => {
    expect(cleanPromptText('<REDACTED>')).toBe('');
    expect(cleanPromptText('REDACTED')).toBe('');
    expect(cleanPromptText('<system-reminder>only system text</system-reminder>')).toBe('');
    expect(cleanPromptText('https://example.com/a')).toBe('');
    expect(cleanPromptText(null)).toBe('');
    expect(cleanPromptText('   ')).toBe('');
  });

  it('hides names in file paths, URLs and personal data', () => {
    const out = cleanPromptText('open /Users/jane.smith/Documents/plan.xlsx and @"/root/.claude/uploads/abc/file.zip" then mail bob@example.com, see https://x.corp/a?b=1');
    // redactPii keeps an email's domain by design (b***@example.com); the local part goes.
    expect(out).not.toMatch(/jane|smith|root|bob@|x\.corp/);
    expect(out).toContain('[path]');
    expect(out).toContain('[link]');
  });
});

describe('stripIdentity (shared with Highlights)', () => {
  it('replaces Windows and Unix paths and URLs, then masks personal data', () => {
    const out = stripIdentity('Read C:\\Users\\alex\\q.docx and /home/alex/notes/plan.md then check https://x.corp/a?b=1 please');
    expect(out).toBe('Read [path] and [path] then check [link] please');
  });
});

describe('formatClues', () => {
  it('writes one line of what a session took in and handed out, or nothing', async () => {
    const { formatClues } = await import('@/lib/usecases/prompt-text');
    expect(formatClues(undefined)).toBe('');
    expect(formatClues({ made: [], uploaded: [], actions: [] })).toBe('');
    expect(formatClues({ made: ['chase-list.md'], uploaded: ['export.csv'], actions: ['gmail create_draft'] }))
      .toBe('files uploaded: export.csv; files made: chase-list.md; connector actions: gmail create_draft');
  });
});
