// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Phase 3 Policy A (jsonb read/write normalisation) — shared helper.
// `alerts.raw_evidence` and friends (compliance_events.metadata,
// cowork_messages.token_usage, otel_events.tool_input/token_usage/file_paths,
// …) are declared `jsonb` on the Postgres schema. Postgres's jsonb codec hands
// back an already-parsed JS value (object/array/etc) on read. Every existing
// consumer of these columns — including ones that call JSON.parse() on the
// value themselves — expects the encoded JSON text (`string | null`), so reads
// normalise back to that one contract.
//
// This file has NO dependency on lib/db/queries.ts (or vice versa) so it can
// be imported directly by any later Phase-3 module (3.1d/3.1f/3.9/3.11 —
// compliance events, cowork messages, OTel events, finance) without pulling
// in the rest of queries.ts.

/**
 * READ normalisation (Policy A). Pass the raw value read back from a jsonb
 * column. Returns a `string | null`:
 *   - null/undefined -> null
 *   - otherwise: the jsonb codec already PARSED the value on read, so it must
 *     always be re-encoded with JSON.stringify, REGARDLESS of the decoded
 *     value's own type.
 *
 * CAVEAT — jsonb scalar strings: a jsonb value can itself be a bare JSON
 * string scalar (e.g. the jsonb value `"foo"`, as opposed to an object like
 * `{"foo":1}`). Postgres's jsonb codec decodes that to the plain JS string
 * `foo` (no quotes). A naive `typeof v === 'string' -> passthrough` branch
 * would therefore return `foo` rather than the encoded `"foo"`. Always
 * JSON.stringify whatever was decoded (even when that's a string). Not
 * triggered by any current column (raw_evidence always stringifies an object)
 * — this helper is slated for reuse on jsonb columns that MAY hold scalar
 * values (otel_events.tool_input etc.), where the distinction matters.
 */
export function jsonToText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

/**
 * WRITE inverse of jsonToText. The app-level contract for these columns is a
 * JSON STRING (e.g. `Alert.raw_evidence: string | null`) — this converts
 * that string into what Drizzle's jsonb column codec expects:
 *   - null/undefined -> null
 *   - otherwise -> the PARSED JS value — its jsonb codec serialises on the
 *     way in, so handing it an already-stringified value would double-encode
 *     (`"\"{...}\""` instead of `{...}`)
 *
 * Malformed JSON is stored as-is (matches the historical no-validation
 * behaviour of the old raw-SQL INSERT path) rather than throwing — a caller
 * passing non-JSON text is a pre-existing bug this conversion must not turn
 * into a hard failure.
 */
export function textToJsonValue(v: string | null | undefined): unknown {
  if (v === null || v === undefined) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
