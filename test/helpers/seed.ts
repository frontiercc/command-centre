// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/** Insert a minimal user row (needed for FKs such as alerts.user_id). */
export async function seedUserSql(sql: import('./sql').TestSql, id: string, email?: string) {
  const now = Math.floor(Date.now() / 1000);
  await sql.run(
    'INSERT INTO users (id, email, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    [id, email ?? `${id}@test.local`, now, now],
  );
}
