// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

const REDACT_PATTERN = /key|secret|token|password/i;
const ALLOWLIST = new Set(['retentionLastResult', 'retentionLastRun']);

export function redactJson(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => redactJson(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (ALLOWLIST.has(key)) {
        result[key] = value;
      } else if (REDACT_PATTERN.test(key) && typeof value === 'string') {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactJson(value);
      }
    }
    return result;
  }

  return obj;
}
