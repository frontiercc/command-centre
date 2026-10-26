// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Stored-content caps for OTel-captured prompts. Application-level limits —
 * both columns are unbounded text() in the DB, so changing these needs no
 * migration, but the change is FORWARD-ONLY: characters beyond the cap are
 * discarded at ingest and can never be backfilled.
 *
 * Raised 120→250 / 1,000→4,000 after measurement:
 * 22% of prompts on both surfaces were pinned at exactly the old 1,000 cap
 * (p90 = cap).
 *
 * Detection (PII/intent) always runs on the FULL prompt before truncation —
 * these caps affect only what is stored, never what is detected.
 *
 * The Chat surface (lib/compliance/chat-sync.ts) deliberately stores prompt
 * text unbounded — capping it would regress what Compliance-API customers
 * already retain.
 */
export const CONTENT_PREVIEW_CHARS = 250;
export const CONTENT_FULL_CHARS = 4000;
