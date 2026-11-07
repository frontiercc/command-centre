// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a Cowork session ran, kept at ingest (migration 0038).
 *
 * Claude Desktop's OTel events carry a `cowork_surface` attribute: `local` for
 * a session on the person's own computer, `remote` for one Anthropic runs in
 * the cloud. Anthropic's monitoring documentation says the otlpContentCapture
 * device policy covers sessions started from Claude Desktop, local or cloud,
 * and that sessions started on the web or in the mobile app carry metadata
 * only whatever the policy says. Keeping the label on each user prompt lets a
 * redacted prompt be read as "the device has not applied the policy yet" or
 * "a session no device setting can reach".
 */

/** The attribute Claude Desktop sends. */
export const SESSION_LOCATION_ATTR = 'cowork_surface';

/** Longest value kept; the documented values are a single word. */
export const SESSION_LOCATION_MAX = 40;

/** A usable location from an OTel value: a non-empty string, trimmed, lower-cased, capped. */
export function sessionLocationLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  return v.slice(0, SESSION_LOCATION_MAX);
}
