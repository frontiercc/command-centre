// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Writes to the auth_events table: sign-in, sign-out, MFA, password and
// session events, plus failed ingest authentication.
import { getTypedClient } from './client';
import { schema } from './schema';

export async function logAuthEvent({
  eventType,
  ipAddress,
  details,
}: {
  eventType: string;
  ipAddress?: string | null;
  details?: string | null;
}): Promise<void> {
  try {
    const db = await getTypedClient();
    await db.insert(schema.authEvents).values({
      agent_id: null,
      event_type: eventType,
      ip_address: ipAddress ?? null,
      details: details ?? null,
    });
  } catch {
    // Auth event logging must never throw
  }
}
