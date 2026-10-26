// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * File upload alert detection — fires when a user uploads a file whose name
 * matches a built-in security pattern or an admin-configured org pattern.
 *
 * Pattern matching is case-insensitive glob: * matches any sequence of chars.
 * Only the filename is checked (not the full path).
 *
 * Two tiers:
 *   Built-in  — always active; covers security-critical file types
 *   Org rules — admin-configured in config key 'file_upload_alert_patterns'
 *               Shape: Array<{ pattern: string; severity: 'low'|'medium'|'high'|'critical'; label: string }>
 */

import { v4 as uuidv4 } from 'uuid';
import { and, eq, gte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { insertAlert } from '@/lib/db/queries';

// ── Built-in patterns ─────────────────────────────────────────────────────
// Security-critical file types that should always be flagged regardless of
// org configuration. Severity reflects data sensitivity.

interface BuiltInRule {
  pattern: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  label: string;
}

const BUILT_IN_RULES: BuiltInRule[] = [
  // Private keys / credentials
  { pattern: '*.pem',          severity: 'critical', label: 'Private key or certificate' },
  { pattern: '*.key',          severity: 'critical', label: 'Private key file' },
  { pattern: '*.p12',          severity: 'critical', label: 'PKCS#12 certificate bundle' },
  { pattern: '*.pfx',          severity: 'critical', label: 'PKCS#12 certificate bundle' },
  { pattern: '*.ppk',          severity: 'critical', label: 'PuTTY private key' },
  { pattern: 'id_rsa',         severity: 'critical', label: 'SSH private key' },
  { pattern: 'id_ed25519',     severity: 'critical', label: 'SSH private key' },
  { pattern: '.env',           severity: 'critical', label: 'Environment secrets file' },
  { pattern: '.env.*',         severity: 'critical', label: 'Environment secrets file' },
  { pattern: '*.env',          severity: 'critical', label: 'Environment secrets file' },
  { pattern: '*secret*',       severity: 'high',     label: 'File with secret in name' },
  { pattern: '*password*',     severity: 'high',     label: 'File with password in name' },
  { pattern: '*credential*',   severity: 'high',     label: 'File with credentials in name' },
  { pattern: '*private_key*',  severity: 'high',     label: 'File with private key in name' },
  // Database dumps
  { pattern: '*.sql',          severity: 'high',     label: 'SQL database dump' },
  { pattern: '*.dump',         severity: 'high',     label: 'Database dump' },
  { pattern: '*.bak',          severity: 'medium',   label: 'Backup file' },
];

// ── Glob matching ─────────────────────────────────────────────────────────

/**
 * Case-insensitive glob match. Only * is supported (matches any sequence).
 * Used for both built-in and org-configured patterns.
 */
export function globMatch(pattern: string, filename: string): boolean {
  const re = new RegExp(
    '^' + pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  );
  return re.test(filename.toLowerCase());
}

/**
 * Extract just the filename from a full path (handles both / and \ separators).
 */
export function extractFilename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

/**
 * Parse <uploaded_files> XML from a user prompt and return just the filenames.
 * Handles multiple files in one prompt. Returns [] if no uploads found.
 */
export function extractUploadedFilenames(promptText: string): string[] {
  const filenames: string[] = [];
  const pathRegex = /<file_path>([^<]+)<\/file_path>/g;
  let match;
  while ((match = pathRegex.exec(promptText)) !== null) {
    const filename = extractFilename(match[1].trim());
    if (filename && !filenames.includes(filename)) {
      filenames.push(filename);
    }
  }
  return filenames;
}

// ── Alert creation ────────────────────────────────────────────────────────

interface OrgRule {
  pattern: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  label: string;
}

/**
 * Load org-configured file upload alert patterns from the config table.
 * Accepts a JSON array of glob pattern strings (admin UI saves comma-separated,
 * stored as JSON string[]).  Each fires as severity='high', label=pattern.
 * Returns [] if not configured or on parse error.
 *
 * Goes through lib/config.ts's getConfigValue (via getTypedClient()) rather
 * than a raw `db.prepare` on the config table.
 */
async function loadOrgRules(): Promise<OrgRule[]> {
  try {
    const value = await getConfigValue('fileUploadAlertPatterns');
    if (!value) return [];
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as string[]).filter(Boolean).map(p => ({
      pattern: p,
      severity: 'high' as const,
      label: `Org-configured pattern: ${p}`,
    }));
  } catch {
    return [];
  }
}

/**
 * Check a list of filenames against built-in and org patterns.
 * Creates one deduped alert per matched rule per user per 24h.
 *
 * Called at ingest time from the OTel receiver immediately after
 * files_uploaded is updated on the session.
 */
export async function createFileUploadAlerts(
  userId: string,
  sessionId: string,
  filenames: string[],
): Promise<number> {
  if (filenames.length === 0) return 0;

  const orgRules = await loadOrgRules();
  const allRules: BuiltInRule[] = [...BUILT_IN_RULES, ...orgRules];

  const client = await getTypedClient();
  const a = schema.alerts;
  // CRITICAL: exact-match on file_alert_label — same ->> expression as the PII
  // dedup (pii-alerts.ts) / getSecurityMetrics (lib/db/queries.ts), NOT a LIKE
  // substring match.
  const labelExpr = sql`raw_evidence ->> 'file_alert_label'`;
  const cutoff = Math.floor(Date.now() / 1000) - 86400; // 24h window (app clock)

  let fired = 0;

  for (const filename of filenames) {
    for (const rule of allRules) {
      if (!globMatch(rule.pattern, filename)) continue;

      // 24h dedup: one alert per user per pattern label per day
      const recentRows = await client
        .select({ one: sql<number>`1` })
        .from(a)
        .where(and(
          eq(a.user_id, userId),
          eq(a.alert_type, 'policy'),
          sql`${labelExpr} = ${rule.label}`,
          gte(a.generated_at, cutoff),
        ))
        .limit(1);

      if (recentRows.length === 0) {
        await insertAlert({
          id: uuidv4(),
          user_id: userId,
          alert_type: 'policy',
          severity: rule.severity,
          title: `Sensitive file uploaded to Claude: ${rule.label}`,
          explanation: `"${filename}" was uploaded to a Claude Cowork session. Pattern matched: ${rule.pattern} (${rule.label}).`,
          raw_evidence: JSON.stringify({
            file_alert_label: rule.label,
            filename,
            session_id: sessionId,
            pattern: rule.pattern,
          }),
        });
        fired++;
      }
    }
  }

  return fired;
}
