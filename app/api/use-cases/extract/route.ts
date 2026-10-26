// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { extractUseCases, extractUseCasesFromPdf } from '@/lib/usecases/extract';

export const dynamic = 'force-dynamic';

// Cap decoded upload size. Claude accepts PDFs up to 32MB, but transcripts are
// small — a low cap keeps request bodies (base64 is ~1.37x) and token spend sane.
const MAX_FILE_BYTES = 15 * 1024 * 1024;

function isPdf(fileName: string, mediaType: string): boolean {
  return mediaType === 'application/pdf' || /\.pdf$/i.test(fileName);
}

function isDocx(fileName: string, mediaType: string): boolean {
  return (
    mediaType.includes('wordprocessingml') || // .docx
    /\.docx$/i.test(fileName)
  );
}

export async function POST(request: NextRequest) {
  if ((await getAllConfig()).useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Text path — pasted transcript or a .txt/.md/.vtt file read client-side.
  if (typeof body.transcript === 'string') {
    try {
      const candidates = await extractUseCases(body.transcript);
      return NextResponse.json({ candidates });
    } catch (err) {
      return errorResponse('UseCases extract', err, { message: 'The AI request failed. Details are in the server log.' });
    }
  }

  // File path — a base64-encoded .pdf or .docx.
  if (typeof body.fileBase64 === 'string' && body.fileBase64.trim() !== '') {
    const fileName = typeof body.fileName === 'string' ? body.fileName : '';
    const mediaType = typeof body.mediaType === 'string' ? body.mediaType : '';

    let buffer: Buffer;
    try {
      buffer = Buffer.from(body.fileBase64, 'base64');
    } catch {
      return NextResponse.json({ error: 'Could not decode the uploaded file' }, { status: 400 });
    }
    if (buffer.length === 0) {
      return NextResponse.json({ error: 'The uploaded file is empty' }, { status: 400 });
    }
    if (buffer.length > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `File is too large (max ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB)` },
        { status: 400 }
      );
    }

    try {
      if (isPdf(fileName, mediaType)) {
        // Re-encode from the decoded buffer to strip any stray whitespace/newlines.
        const candidates = await extractUseCasesFromPdf(buffer.toString('base64'));
        return NextResponse.json({ candidates });
      }

      if (isDocx(fileName, mediaType)) {
        const mammoth = (await import('mammoth')).default;
        const { value: text } = await mammoth.extractRawText({ buffer });
        if (!text || text.trim() === '') {
          return NextResponse.json({ error: 'No text could be extracted from that document' }, { status: 400 });
        }
        const candidates = await extractUseCases(text);
        return NextResponse.json({ candidates });
      }

      return NextResponse.json(
        { error: 'Unsupported file type. Upload a .txt, .md, .vtt, .pdf, or .docx file.' },
        { status: 400 }
      );
    } catch (err) {
      return errorResponse('UseCases extract', err, { message: 'Could not read that file or extract use cases from it. Details are in the server log.' });
    }
  }

  return NextResponse.json({ error: 'transcript or file is required' }, { status: 400 });
}
