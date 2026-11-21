// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A classification's prompt fields, read from the copies on pulse_classifications (migration 0065,
// kept equal to cowork_messages by database triggers) under the alias `cm`, so a query written as
// "pulse_classifications pc JOIN cowork_messages cm" reads the same columns without touching the
// messages table. Only these columns exist on the alias: id, occurred_at, session_id, user_id,
// surface and source. Postgres folds the subquery away, so filters use the copies' indexes.
import { sql } from 'drizzle-orm';

export const PC_MESSAGE = sql.raw(
  'CROSS JOIN LATERAL (SELECT pc.cowork_message_id AS id, pc.msg_occurred_at AS occurred_at, '
  + 'pc.msg_session_id AS session_id, pc.msg_user_id AS user_id, pc.msg_surface AS surface, pc.msg_source AS source) cm',
);
