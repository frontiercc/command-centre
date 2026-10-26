// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pure and client-safe. Shared by the use case session judge (a session that
// runs a use case's own codified skill) and the tracker's tests.

/**
 * Skill/connector rule match. Exact, or a marketplace-prefixed telemetry name
 * whose suffix after the last ':' is a rule member — an org skill uploaded to
 * the claude.ai library can arrive over OTel as `<marketplace>:<name>` (the
 * way Anthropic's own arrive as `anthropic-skills:docx`). Case-insensitive.
 * Added for "Turn this into a skill", whose codified skill
 * name is written to the rule before anyone has used it.
 */
export function signalMatches(set: Set<string>, name: string): boolean {
  if (!name) return false;
  // Fast path: an exact (or exact-suffix) hit is a Set lookup, so the common
  // case never walks the rule's set once per telemetry row.
  if (set.has(name)) return true;
  const lc = name.toLowerCase();
  if (set.has(lc)) return true;
  const colon = name.lastIndexOf(':');
  const bare = lc.includes(':') ? lc.slice(lc.lastIndexOf(':') + 1) : null;
  if (colon >= 0 && set.has(name.slice(colon + 1))) return true;
  if (bare !== null && set.has(bare)) return true;
  // Slow path: only an exact miss reaches here, for the case-insensitive pass.
  for (const s of set) {
    const slc = s.toLowerCase();
    if (slc === lc) return true;
    if (bare !== null && slc === bare) return true;
  }
  return false;
}
