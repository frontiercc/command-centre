// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Full chat conversation thread for the audit
// log, mirroring app/api/cowork/messages/route.ts's session-thread shape.
// Merges chat_messages (user prompts, real text) with chat_assistant_meta
// (assistant turns — model + artifact/generated-file counts, structurally NO
// text column exists on that table) for one conversation_id, ordered by
// occurred_at ascending so the thread reads top-to-bottom chronologically.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { gateContentRead, scopedDepartment, filterRowsToDepartment } from '@/lib/auth/content-access';

// Disable Next.js route caching — all API routes read live data
export const dynamic = 'force-dynamic';

interface ChatThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  occurred_at: number;
  flagged: number;
  flag_reason: string | null;
  model?: string | null;
  artifacts_count?: number;
  generated_files_count?: number;
}

export async function GET(request: NextRequest) {
  // Same gate as /api/events; a department-scoped caller sees only rows
  // belonging to users in their department.
  const gate = await gateContentRead(request, 'chat/thread');
  if ('response' in gate) return gate.response;
  const department = scopedDepartment(gate.session);

  const conversationId = request.nextUrl.searchParams.get('conversationId');
  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 });
  }

  const client = await getTypedClient();

  // User prompts — real text (may be the retention-strip marker, or even a
  // blank string; never filtered on truthiness so a stripped row still shows).
  const promptRows = await filterRowsToDepartment(await client
    .select({
      id: schema.chatMessages.id,
      user_id: schema.chatMessages.user_id,
      prompt_text: schema.chatMessages.prompt_text,
      occurred_at: schema.chatMessages.occurred_at,
      flagged: schema.chatMessages.flagged,
      flag_reason: schema.chatMessages.flag_reason,
    })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.conversation_id, conversationId)), department);

  // Assistant turns — metadata only, no text column exists on this table.
  const assistantRows = await filterRowsToDepartment(await client
    .select({
      id: schema.chatAssistantMeta.id,
      user_id: schema.chatAssistantMeta.user_id,
      model: schema.chatAssistantMeta.model,
      artifacts_count: schema.chatAssistantMeta.artifacts_count,
      generated_files_count: schema.chatAssistantMeta.generated_files_count,
      occurred_at: schema.chatAssistantMeta.occurred_at,
    })
    .from(schema.chatAssistantMeta)
    .where(eq(schema.chatAssistantMeta.conversation_id, conversationId)), department);

  const messages: ChatThreadMessage[] = [
    ...promptRows.map((r): ChatThreadMessage => ({
      id: r.id,
      role: 'user',
      content: r.prompt_text ?? '',
      occurred_at: Number(r.occurred_at),
      flagged: Number(r.flagged ?? 0),
      flag_reason: r.flag_reason ?? null,
    })),
    ...assistantRows.map((r): ChatThreadMessage => ({
      id: r.id,
      role: 'assistant',
      // Synthesised marker only — the real signal is the fields below.
      content: 'Claude replied',
      occurred_at: Number(r.occurred_at),
      flagged: 0,
      flag_reason: null,
      model: r.model ?? null,
      artifacts_count: Number(r.artifacts_count ?? 0),
      generated_files_count: Number(r.generated_files_count ?? 0),
    })),
  ].sort((a, b) => a.occurred_at - b.occurred_at);

  return NextResponse.json({ messages });
}
