// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { renderDigestHtml, renderDigestSlack } from '@/lib/digest/render';
import { SAMPLE_DIGEST_DATA, SAMPLE_WATERMARK } from '@/lib/digest/sample';

const HUB_URL = 'https://ccc.example.com';

describe('SAMPLE_DIGEST_DATA', () => {
  it('renders as HTML without throwing', () => {
    expect(() => renderDigestHtml(SAMPLE_DIGEST_DATA, HUB_URL)).not.toThrow();
  });

  it('renders as Slack payload without throwing', () => {
    expect(() => renderDigestSlack(SAMPLE_DIGEST_DATA, HUB_URL)).not.toThrow();
  });

  it('produces HTML containing the expected content sections', () => {
    const html = renderDigestHtml(SAMPLE_DIGEST_DATA, HUB_URL);
    expect(html).toContain('Developer Pulse');
    expect(html).toContain('Work Pulse');
    expect(html).toContain('Open Command Centre');
  });

  it('has a non-empty watermark string distinct from real data', () => {
    expect(SAMPLE_WATERMARK).toBeTruthy();
    expect(SAMPLE_WATERMARK.toUpperCase()).toContain('SAMPLE DATA');
  });
});
