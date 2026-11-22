// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Uncapped alert counts and category resolution shared by the alerts routes.
// The list (getAlerts) stops at 500 rows, so every count the pages show is
// read here with SQL instead of from the length of a list.

import { eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { ALERT_CATEGORIES, typesForCategory } from '@/lib/alerts/categories';

export interface AlertCountRow {
  status: string;
  alert_type: string;
  count: number;
}

/** Alerts grouped by status and type, optionally for one department. */
export async function countAlertsByStatusAndType(department?: string): Promise<AlertCountRow[]> {
  const db = await getTypedClient();
  const a = schema.alerts;
  const u = schema.users;
  const base = db
    .select({ status: a.status, alert_type: a.alert_type, count: sql<number | string>`count(*)` })
    .from(a);
  const rows = department
    ? await base.leftJoin(u, eq(a.user_id, u.id)).where(eq(u.department, department)).groupBy(a.status, a.alert_type)
    : await base.groupBy(a.status, a.alert_type);
  return rows.map(r => ({ status: r.status ?? '', alert_type: r.alert_type, count: Number(r.count) }));
}

const KNOWN_TYPES = new Set(Object.values(ALERT_CATEGORIES).flat());

/**
 * The alert types a category covers. "Other" has no fixed list: it is every
 * type stored that no named category claims. Returns null when no category was
 * asked for, and a list that matches nothing when "Other" is empty, so a bulk
 * change for an empty category never touches every alert.
 */
export async function typesForCategoryParam(category: string | undefined): Promise<string[] | null> {
  if (!category) return null;
  if (category !== 'other') {
    const types = typesForCategory(category);
    return types.length ? types : null;
  }
  const db = await getTypedClient();
  const a = schema.alerts;
  const rows = await db.selectDistinct({ t: a.alert_type }).from(a);
  const other = rows.map(r => r.t).filter(t => !KNOWN_TYPES.has(t));
  return other.length ? other : ['__no_such_alert_type__'];
}
