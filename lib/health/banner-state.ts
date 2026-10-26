// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// lib/health/banner-state.ts
/**
 * Decide whether the database-unavailable banner should show.
 * Only a successful /api/health poll reporting "degraded" shows the banner;
 * a failed poll (the client's own connectivity) must NOT raise a false alarm.
 */
export function shouldShowBanner(input: { fetchOk: boolean; status?: string }): boolean {
  return input.fetchOk === true && input.status === 'degraded';
}
