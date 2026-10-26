// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Exec Digest — HTML preview.
 *
 * Renders the same HTML the email channel would send
 * (lib/digest/render.ts renderDigestHtml), using real data from
 * buildDigest() when a completed week exists, or the built-in
 * SAMPLE_DIGEST_DATA otherwise (see lib/digest/sample.ts) so the preview
 * always renders something on a fresh instance. The sample case is
 * clearly watermarked at the top of the returned HTML — never mixed
 * silently with real numbers.
 *
 * Returns raw HTML from an authenticated route (admin/manager — same gate
 * as /admin/pulse via canAccessPulseAdmin). This does not weaken the
 * middleware: session auth still applies, this only changes the response
 * Content-Type for a page meant to be opened directly in a new tab.
 */
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getConfigValue } from '@/lib/config';
import { buildDigest } from '@/lib/digest/build';
import { renderDigestHtml } from '@/lib/digest/render';
import { SAMPLE_DIGEST_DATA, SAMPLE_WATERMARK } from '@/lib/digest/sample';

export const dynamic = 'force-dynamic';

function watermarkBanner(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FEF3C7;padding:24px 0 0 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="padding:10px 16px;background-color:#92400E;border-radius:6px 6px 0 0;font-family:Arial,Helvetica,sans-serif;">
            <p style="margin:0;font-size:12px;font-weight:bold;color:#FFFFFF;text-align:center;text-transform:uppercase;letter-spacing:0.05em;">${SAMPLE_WATERMARK}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const data = await buildDigest();
    const isSample = data === null;
    const hubUrl = (await getConfigValue('digestHubUrl')) || 'http://localhost:3001';

    const html = renderDigestHtml(data ?? SAMPLE_DIGEST_DATA, hubUrl);
    const body = isSample ? `${watermarkBanner()}${html}` : html;

    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    return errorResponse('api/admin/digest/preview', err);
  }
}
