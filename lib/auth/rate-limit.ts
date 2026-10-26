// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// In-memory sliding window rate limiter
type RateLimitStore = Map<string, { timestamps: number[] }>;

const store: RateLimitStore = new Map();

// Cleanup stale entries every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD = 2 * 60 * 1000; // 2 minutes

// unref() allows the process to exit cleanly (important for test runners)
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of Array.from(store.entries())) {
    // Remove timestamps older than stale threshold
    value.timestamps = value.timestamps.filter((ts) => now - ts < STALE_THRESHOLD);
    // Delete entry if no timestamps remain
    if (value.timestamps.length === 0) {
      store.delete(key);
    }
  }
}, CLEANUP_INTERVAL);
cleanup.unref();

/**
 * Check if a request should be rate limited using a sliding window approach
 * @param key - unique identifier (e.g., IP address, agent ID)
 * @param maxRequests - max requests allowed in the window
 * @param windowMs - time window in milliseconds (default: 60000 = 1 minute)
 * @returns true if the request should be REJECTED (rate limited), false otherwise
 */
export function isRateLimited(
  key: string,
  maxRequests: number,
  windowMs: number = 60000
): boolean {
  const now = Date.now();

  // Get or create entry for this key
  if (!store.has(key)) {
    store.set(key, { timestamps: [] });
  }

  const entry = store.get(key)!;

  // Filter out timestamps outside the current window
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);

  // Check if we've exceeded the limit
  if (entry.timestamps.length >= maxRequests) {
    return true; // Rate limited
  }

  // Add current timestamp and allow the request
  entry.timestamps.push(now);
  return false; // Not rate limited
}
