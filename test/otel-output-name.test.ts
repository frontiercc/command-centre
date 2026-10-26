// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Output file names from tool parameters: the name only —
// never a directory, never content — and only for output tools.
import { describe, it, expect } from 'vitest';
import { outputFileName } from '@/lib/otel/output-name';

describe('outputFileName', () => {
  it('takes the base name of a Write file_path from tool_parameters', () => {
    expect(outputFileName('Write', { file_path: '/sessions/abc/outputs/Q3-variance.xlsx' }, undefined)).toBe('Q3-variance.xlsx');
  });

  it('handles Windows paths', () => {
    expect(outputFileName('Write', { file_path: 'C:\\Users\\x\\Documents\\board-pack.docx' }, undefined)).toBe('board-pack.docx');
  });

  it('falls back to tool_input and never returns its content', () => {
    const input = JSON.stringify({ file_path: '/out/summary.md', content: 'Confidential salary review for Jane Smith' });
    const name = outputFileName('Write', null, input);
    expect(name).toBe('summary.md');
    expect(name).not.toContain('salary');
  });

  it('joins a list of sent files', () => {
    expect(outputFileName('SendUserFile', { files: ['/a/one.pdf', '/b/two.pptx', '/a/one.pdf'] }, undefined)).toBe('one.pdf, two.pptx');
  });

  it('uses an artifact title when there is no path', () => {
    expect(outputFileName('Artifact', null, JSON.stringify({ title: 'Pipeline summary' }))).toBe('Pipeline summary');
  });

  it('ignores tools that are not outputs', () => {
    expect(outputFileName('Read', { file_path: '/x/secret.xlsx' }, undefined)).toBeNull();
    expect(outputFileName('Bash', { full_command: 'cat /etc/passwd' }, undefined)).toBeNull();
  });

  it('returns null when nothing names the output, or tool_input was truncated mid-JSON', () => {
    expect(outputFileName('Write', {}, undefined)).toBeNull();
    expect(outputFileName('Write', null, '{"file_path": "/out/rep')).toBeNull();
  });

  it('scrubs personal data in the name', () => {
    const name = outputFileName('Write', { file_path: '/out/notes-jane.doe@example.com.md' }, undefined);
    expect(name).not.toContain('jane.doe@example.com');
  });
});
