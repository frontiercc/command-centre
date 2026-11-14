// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Sample work happens in working hours, as real work mostly does: weekdays, 9am to 5pm in the
// organisation's own timezone (the one Admin sets for telemetry alerts). Out-of-hours figures,
// such as So What's evenings card, are only meaningful against that.

/** The organisation's timezone, as Command Centre reads it (lib/config.ts), London when unset. */
async function orgTimezone(client) {
  const row = (await client.query(`SELECT value FROM config WHERE key = 'telemetry_silence_timezone'`)).rows[0];
  return (row && row.value) || 'Europe/London';
}

/** A function giving the most recent working moment at or before a time: weekday, 9am to 5pm, local. */
function workingTime(timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const working = (t) => {
    const parts = fmt.formatToParts(new Date(t * 1000));
    const weekday = parts.find(p => p.type === 'weekday').value;
    const hour = Number(parts.find(p => p.type === 'hour').value);
    return weekday !== 'Sat' && weekday !== 'Sun' && hour >= 9 && hour < 17;
  };
  return (t) => {
    // Step back an hour at a time, at most three days, keeping the minutes.
    for (let back = 0; back < 72; back++) {
      const candidate = t - back * 3600;
      if (working(candidate)) return candidate;
    }
    return t;
  };
}

module.exports = { orgTimezone, workingTime };
