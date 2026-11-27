// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Ask the data (admin only). GET says whether it is available to this person (the sidebar,
// the jump-to search and the drawer use it); POST answers one question from the page lookups
// (lib/ask), on Claude Haiku 5.5, within the admin's monthly spend cap, and logs the question,
// lookups, outcome and cost. The answer text is returned, never stored.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getAllConfig } from '@/lib/config';
import { logAccess } from '@/lib/audit/log';
import { errorResponse } from '@/lib/api/errors';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { askQuestion, ASK_MODEL, type AskTurn } from '@/lib/ask/run';
import { costOf, logQuestion, spendThisMonth } from '@/lib/ask/log';
import { getClaudeCredential } from '@/lib/anthropic/credential';

export const dynamic = 'force-dynamic';

const MAX_QUESTION = 500;

function capOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession(request);
    if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Every role may ask whether it is available; only an admin ever gets a yes.
    if (session.role !== 'admin') return NextResponse.json({ available: false });
    const cfg = await getAllConfig();
    const hasKey = !!(await getClaudeCredential());
    return NextResponse.json({ available: cfg.askEnabled === true && hasKey, enabled: cfg.askEnabled === true, hasKey });
  } catch (err) {
    return errorResponse('ask GET', err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession(request);
    if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const actorIp = request.headers.get('x-forwarded-for') || undefined;
    if (session.role !== 'admin') {
      await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'ask', action: 'READ', outcome: 'denied' });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json().catch(() => null) as { question?: unknown; history?: unknown; page?: unknown; pageNote?: unknown } | null;
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question) return NextResponse.json({ error: 'Type a question.' }, { status: 400 });
    if (question.length > MAX_QUESTION) return NextResponse.json({ error: `Questions can be up to ${MAX_QUESTION} characters.` }, { status: 400 });
    const page = typeof body?.page === 'string' && body.page.startsWith('/') ? body.page.slice(0, 200) : null;
    // What the page shows (period, team, product filter), so "this page" questions match the screen.
    const pageNote = typeof body?.pageNote === 'string' ? body.pageNote.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
    const history: AskTurn[] = Array.isArray(body?.history)
      ? (body!.history as unknown[]).filter((t): t is AskTurn => !!t && typeof (t as AskTurn).question === 'string').slice(-4).map(t => ({ question: t.question.slice(0, MAX_QUESTION), answer: '' }))
      : [];

    const cfg = await getAllConfig();
    if (cfg.askEnabled !== true) return NextResponse.json({ error: 'Ask the data is turned off. An admin can turn it on in Admin, Ask the data.' }, { status: 409 });
    const apiKey = await getClaudeCredential();
    if (!apiKey) return NextResponse.json({ error: 'No Claude API key is set. Add one in Admin → Access & Keys.' }, { status: 409 });

    const nowS = Math.floor(Date.now() / 1000);
    const retentionDays = Math.max(1, Math.round(Number(cfg.askLogRetentionDays) || 90));
    const cap = capOf(cfg.askMonthlyCapUsd);
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp, resource: 'ask', action: 'READ', outcome: 'success' });
    if ((await spendThisMonth(nowS)) >= cap) {
      await logQuestion({ askedBy: session.email!, question, page, lookups: [], outcome: 'capped', model: ASK_MODEL, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, durationMs: 0, nowS, retentionDays });
      return NextResponse.json({ outcome: 'capped', answer: `This month's spend cap for Ask the data ($${cap}) has been reached. An admin can raise it in Admin, Ask the data.`, sources: [] });
    }

    const started = Date.now();
    const today = new Date(nowS * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const result = await askQuestion({ client: createAnthropicClient(apiKey), question, history, page, pageNote, ctx: { request }, today });
    const costUsd = await costOf(ASK_MODEL, result.usage);
    await logQuestion({ askedBy: session.email!, question, page, lookups: result.lookups, outcome: result.outcome, model: ASK_MODEL, usage: result.usage, costUsd, durationMs: Date.now() - started, nowS, retentionDays });
    return NextResponse.json({ outcome: result.outcome, answer: result.answer, sources: result.sources, trimmed: result.trimmed === true });
  } catch (err) {
    return errorResponse('ask POST', err, { message: 'Ask the data could not answer that. The details are in the server log.' });
  }
}
