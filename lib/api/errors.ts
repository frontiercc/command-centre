// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Error responses that never carry an exception's text to the caller.
// Driver, SDK and database messages can reveal
// table names, hosts, keys' shapes or query fragments; the detail belongs in the
// server log, and the caller gets a fixed message. Use a specific fixed `message`
// where an admin needs a hint to act on (e.g. "check the bucket and credentials").
import { NextResponse } from 'next/server';

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. The details are in the server log.';

/** Log `err` under `context` and return a JSON error with fixed text. */
export function errorResponse(
  context: string,
  err: unknown,
  opts: { status?: number; message?: string; extra?: Record<string, unknown> } = {},
): NextResponse {
  logError(context, err);
  return NextResponse.json(
    { ...(opts.extra ?? {}), error: opts.message ?? GENERIC_ERROR_MESSAGE },
    { status: opts.status ?? 500 },
  );
}

/** Log an error's detail (message + stack) server-side only. */
export function logError(context: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[${context}]`, detail);
}

/** For results that carry a list of error strings from library code: log each,
 *  return a single fixed line (or nothing when there were none). */
export function sanitizeErrors(context: string, errors: readonly string[] | undefined | null): string[] {
  if (!errors || errors.length === 0) return [];
  for (const e of errors) logError(context, e);
  return [`${errors.length} error${errors.length === 1 ? '' : 's'}. Details are in the server log.`];
}

/** A Compliance sync result with its library error text replaced by fixed lines (detail logged). */
export function safeComplianceResult<T extends { chat: { errors: string[] } | null; activity: { errors: string[] } | null }>(ctx: string, r: T): T {
  return {
    ...r,
    ...(r.chat ? { chat: { ...r.chat, errors: sanitizeErrors(ctx, r.chat.errors) } } : {}),
    ...(r.activity ? { activity: { ...r.activity, errors: sanitizeErrors(ctx, r.activity.errors) } } : {}),
  };
}
