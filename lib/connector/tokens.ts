// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Token lifecycle for the CCC Metrics Connector.
 *
 * Uses the token primitives in lib/auth/tokens.ts:
 * generateToken() for the 256-bit base62 plaintext, hashToken() (SHA-256 hex) for
 * at-rest storage, timingSafeCompare() is not needed here because lookup is by
 * hash equality (indexed, unique column) rather than direct secret comparison.
 *
 * Plaintext tokens are never persisted and never returned again after mint.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';

const TOKEN_PREFIX = 'ccc_connector';

const nowSec = () => Math.floor(Date.now() / 1000);

export interface ConnectorToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface ConnectorTokenRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function toRecord(row: ConnectorTokenRow): ConnectorToken {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Strip an optional "Bearer " prefix and trim whitespace. Callers may pass
 * either form. The scheme name is matched case-insensitively per RFC 7235
 * (auth-scheme tokens are case-insensitive) — accepts "Bearer", "bearer",
 * "BEARER", etc.
 */
function normalizeBearer(bearer: string | null | undefined): string | null {
  if (!bearer) return null;
  const trimmed = bearer.trim();
  if (!trimmed) return null;
  return /^bearer /i.test(trimmed) ? trimmed.slice(7).trim() : trimmed;
}

/** Mint a new connector token. Returns the plaintext token exactly once — it is never persisted. */
export async function mintConnectorToken(name: string): Promise<{ token: string; record: ConnectorToken }> {
  const db = await getTypedClient();
  const token = generateToken(TOKEN_PREFIX);
  const tokenHash = hashToken(token);
  const id = uuidv4();
  const createdAt = nowSec();

  // .returning() (not .lastInsertRowid) so the minted record is read straight
  // from the row the DB actually persisted.
  const inserted = (await db
    .insert(schema.connectorTokens)
    .values({
      id,
      name,
      token_hash: tokenHash,
      created_at: createdAt,
      last_used_at: null,
      revoked_at: null,
    })
    .returning()) as ConnectorTokenRow[];

  const row = inserted[0];
  return {
    token,
    record: toRecord(row),
  };
}

/** List all connector tokens. Never includes the token hash. */
export async function listConnectorTokens(): Promise<ConnectorToken[]> {
  const db = await getTypedClient();
  const rows = (await db
    .select({
      id: schema.connectorTokens.id,
      name: schema.connectorTokens.name,
      created_at: schema.connectorTokens.created_at,
      last_used_at: schema.connectorTokens.last_used_at,
      revoked_at: schema.connectorTokens.revoked_at,
    })
    .from(schema.connectorTokens)
    .orderBy(desc(schema.connectorTokens.created_at))) as Omit<ConnectorTokenRow, 'token_hash'>[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }));
}

/** Revoke a token by id. Idempotent: returns false if already revoked or unknown. */
export async function revokeConnectorToken(id: string): Promise<boolean> {
  const db = await getTypedClient();
  const rows = (await db
    .select({ revoked_at: schema.connectorTokens.revoked_at })
    .from(schema.connectorTokens)
    .where(eq(schema.connectorTokens.id, id))
    .limit(1)) as Array<{ revoked_at: number | null }>;
  const row = rows[0];
  if (!row || row.revoked_at !== null) return false;

  await db
    .update(schema.connectorTokens)
    .set({ revoked_at: nowSec() })
    .where(and(eq(schema.connectorTokens.id, id), isNull(schema.connectorTokens.revoked_at)));
  return true;
}

/**
 * Verify a bearer token. Accepts either the raw token or a full "Bearer <token>"
 * string (normalised here so callers don't have to strip the prefix themselves).
 * Returns null for missing/unknown/revoked tokens. Bumps last_used_at on success.
 *
 * SECURITY: this is bearer-token auth for the Metrics Connector —
 * every caller (middleware / /api/export/* / /api/mcp) MUST `await` it. A
 * floating Promise would be truthy and authenticate every request; a
 * mishandled rejection would deny all.
 */
export async function verifyConnectorToken(bearer: string | null | undefined): Promise<ConnectorToken | null> {
  const token = normalizeBearer(bearer);
  if (!token) return null;

  const db = await getTypedClient();
  const tokenHash = hashToken(token);
  const rows = (await db
    .select()
    .from(schema.connectorTokens)
    .where(eq(schema.connectorTokens.token_hash, tokenHash))
    .limit(1)) as ConnectorTokenRow[];
  const row = rows[0];
  if (!row || row.revoked_at !== null) return null;

  const lastUsedAt = nowSec();
  await db
    .update(schema.connectorTokens)
    .set({ last_used_at: lastUsedAt })
    .where(eq(schema.connectorTokens.id, row.id));

  return toRecord({ ...row, last_used_at: lastUsedAt });
}
