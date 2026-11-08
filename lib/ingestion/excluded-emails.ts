// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Admin → Ingestion exclusion list, read by the syncs that pull from an
// API (OpenAI's Compliance API, Anthropic's Compliance API). The OTel receivers read
// the same config key themselves.
import { getConfigValue } from '@/lib/config';

/** The list (a JSON array of emails), lower-cased. Malformed reads as empty. */
export function parseExcludedEmails(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return new Set();
    return new Set(list.filter((e): e is string => typeof e === 'string').map(e => e.trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function loadExcludedEmails(): Promise<Set<string>> {
  return parseExcludedEmails(await getConfigValue('otelExcludedEmails'));
}
