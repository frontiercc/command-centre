// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { officeProduct, changedDocument, documentFileName } from '@/lib/otel/office-receiver';

describe('office receiver helpers', () => {
  it('maps each Office surface to its app', () => {
    expect(officeProduct('sheet')).toBe('excel');
    expect(officeProduct('doc')).toBe('word');
    expect(officeProduct('slide')).toBe('powerpoint');
    expect(officeProduct('mail')).toBe('outlook');
    expect(officeProduct('something-new')).toBeNull();
    expect(officeProduct(undefined)).toBeNull();
    // Microsoft says so explicitly too.
    expect(officeProduct('doc', 'm')).toBe('word');
  });

  it('maps each Google surface to its app when agent.vendor is g', () => {
    expect(officeProduct('sheet', 'g')).toBe('sheets');
    expect(officeProduct('doc', 'g')).toBe('docs');
    expect(officeProduct('slide', 'G ')).toBe('slides');
    // Google has no mail add-in; an unknown Google surface is not guessed at.
    expect(officeProduct('mail', 'g')).toBeNull();
  });

  it('counts writes and Word proposed edits as changing the document', () => {
    expect(changedDocument('execute_office_js', 'write')).toBe(true);
    expect(changedDocument('propose_doc_edits', 'read')).toBe(true);
    expect(changedDocument('get_range_as_csv', 'read')).toBe(false);
    expect(changedDocument('web_search', undefined)).toBe(false);
  });

  it('keeps only the file name of the document', () => {
    expect(documentFileName('https://example.sharepoint.com/sites/Finance/Shared%20Documents/Q3%20Budget.xlsx?web=1#x')).toBe('Q3 Budget.xlsx');
    expect(documentFileName('C:\\Users\\someone\\Documents\\Board pack.pptx')).toBe('Board pack.pptx');
    expect(documentFileName('')).toBeNull();
    expect(documentFileName(undefined)).toBeNull();
    expect(documentFileName('https://example.com/')).toBeNull();
  });

  it('scrubs personal data from the file name', () => {
    expect(documentFileName('https://x.example.com/docs/jane.doe%40example.org%20notes.docx')).not.toContain('jane.doe@example.org');
  });
});
