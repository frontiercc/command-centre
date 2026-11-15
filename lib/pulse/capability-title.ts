// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/** How a new capability's title is saved: "New capability: Engineering · Architecture". */
export function capabilityTitle(readableType: string): string {
  return `New capability: ${readableType}`;
}

/**
 * A capability title as pages and exports show it: the kind of work alone.
 * Handles every saved form: "New capability: …" (from 1.4.0), "New capability — …" (earlier
 * rows) and the legacy "Capability creation candidate (some_slug)" → "Some Slug".
 * Client-safe, no imports.
 */
export function cleanTitle(title: string): string {
  const legacyMatch = title.match(/^Capability creation candidate \((.+)\)$/i);
  if (legacyMatch) {
    return legacyMatch[1]
      .replace(/:/g, ' · ')
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  return title.replace(/^New capability\s*[:—–-]\s*/i, '');
}
