// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code telemetry settings filled in with this install's collector
 * address and bearer token: the managed settings block from the README and
 * docs/connect-claude.md. Client-safe: no server imports.
 */
const VARS = (address: string, token: string): Array<[string, string]> => [
  ['CLAUDE_CODE_ENABLE_TELEMETRY', '1'],
  ['OTEL_EXPORTER_OTLP_ENDPOINT', address],
  ['OTEL_EXPORTER_OTLP_HEADERS', `Authorization=Bearer ${token}`],
  ['OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE', 'delta'],
  ['OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf'],
  ['OTEL_LOGS_EXPORTER', 'otlp'],
  ['OTEL_LOG_TOOL_DETAILS', '1'],
  ['OTEL_LOG_USER_PROMPTS', '1'],
  ['OTEL_METRICS_EXPORTER', 'otlp'],
  ['OTEL_SERVICE_NAME', 'claude-code'],
];

/** The managed settings JSON for claude.ai → Organization settings → Claude Code. */
export function claudeCodeSettings(address: string, token: string): string {
  return JSON.stringify({ env: Object.fromEntries(VARS(address, token)) }, null, 2);
}
