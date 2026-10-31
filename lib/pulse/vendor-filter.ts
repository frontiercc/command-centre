// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Drizzle conditions for Work Pulse's Claude / OpenAI split, built on the
// dashboard's fixed SQL strings (lib/dashboard/product-sql.ts). 'all' is TRUE,
// so passing it changes nothing.
import { sql, type SQL } from 'drizzle-orm';
import { vendorClause } from '@/lib/dashboard/product-sql';
import type { Vendor } from '@/lib/dashboard/vendor';

/** cowork_messages rows from the vendor, for queries that join the unaliased table. */
export function messageVendor(vendor: Vendor): SQL {
  return sql.raw(vendorClause(vendor, 'cowork_messages.'));
}

/** cowork_mcp_invocations rows from the vendor. */
export function connectorVendor(vendor: Vendor): SQL {
  return sql.raw(vendorClause(vendor, 'cowork_mcp_invocations.'));
}

/** cowork_skill_invocations rows from the vendor. */
export function skillVendor(vendor: Vendor): SQL {
  return sql.raw(vendorClause(vendor, 'cowork_skill_invocations.'));
}

/** The two vendors Work Pulse saves separate figures for. */
export const SPLIT_VENDORS = ['claude', 'openai'] as const;
export type SplitVendor = (typeof SPLIT_VENDORS)[number];
