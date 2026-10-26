// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Removes leftover testcontainers (label org.testcontainers=true) that survive
// interrupted or timed-out PG test legs on the local machine. Runs automatically
// after `npm run test` (posttest) and on demand via `npm run test:cleanup`.
// The label filter can never match the real ccc-postgres / demo containers.
import { execSync } from 'node:child_process';
try {
  const ids = execSync('docker ps -aq --filter label=org.testcontainers=true', { encoding: 'utf8' }).trim();
  if (!ids) { console.log('[clean-testcontainers] none found.'); process.exit(0); }
  const list = ids.split(/\s+/);
  execSync(`docker rm -f ${list.join(' ')}`, { stdio: 'ignore' });
  console.log(`[clean-testcontainers] removed ${list.length} leftover testcontainer(s).`);
} catch {
  console.log('[clean-testcontainers] docker unavailable or nothing to clean.');
}
