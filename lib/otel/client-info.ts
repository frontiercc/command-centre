// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Which Claude Desktop build and operating system sent a Claude Cowork prompt,
 * kept at ingest (migration 0058).
 *
 * Anthropic's Cowork monitoring documentation lists `service.version` (the
 * Claude app version), `os.type` and `os.version` as resource attributes on
 * every Cowork event. Keeping them on each user prompt shows whether prompts
 * that arrive redacted come from particular builds or operating systems. They
 * sit on the prompt, not the session, because one person can use two machines
 * on the same day. Labels, not content.
 */

type Attr = { key: string; value: { stringValue?: string; intValue?: string | number } };

/** Longest value kept; real values are a short version or OS string. */
const CLIENT_INFO_MAX = 80;

function read(attrs: Attr[], key: string): string | undefined {
  const a = attrs.find((x) => x.key === key);
  if (!a) return undefined;
  return a.value.stringValue ?? a.value.intValue?.toString() ?? undefined;
}

function label(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  return v.slice(0, CLIENT_INFO_MAX);
}

/** Client version and operating system, from the resource first, then the record. */
export function clientInfo(resAttrs: Attr[], attrs: Attr[]): {
  client_version: string | null;
  os_type: string | null;
  os_version: string | null;
} {
  const pick = (key: string) => label(read(resAttrs, key) ?? read(attrs, key));
  return {
    client_version: pick('service.version'),
    os_type: pick('os.type'),
    os_version: pick('os.version'),
  };
}
