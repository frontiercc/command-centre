// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Which teams a caller may see on Team coaching: an admin any team (the one
 * asked for, else the first), a manager only their own department, whatever
 * they ask for. A manager with no department sees nothing.
 */
import type { UserRole } from '@/lib/auth/admin-auth';

export type CoachingScope = { teams: string[]; department: string | null } | { error: string };

export function coachingScope(
  session: { role?: UserRole; department?: string | null },
  allTeams: string[],
  asked: string | null,
): CoachingScope {
  if (session.role === 'admin') {
    const department = asked && allTeams.includes(asked) ? asked : (allTeams[0] ?? null);
    return { teams: allTeams, department };
  }
  const own = session.department?.trim();
  if (!own) return { error: 'Your account has no department, so there is no team to coach. An admin can set it.' };
  return { teams: [own], department: own };
}

/** The name So What files a card about the whole organisation under, rather than one team. */
export const EVERYONE = 'Everyone';

/**
 * Whether a caller may take a So What decision for `department`: an admin for any team and for the
 * cards about the whole organisation (EVERYONE), a manager only for their own team. Returns the
 * reason when they may not.
 */
export function decisionScope(
  session: { role?: UserRole; department?: string | null },
  allTeams: string[],
  department: string,
): { ok: true } | { error: string } {
  const scope = coachingScope(session, [...allTeams, EVERYONE], department);
  if ('error' in scope) return scope;
  return scope.department === department ? { ok: true } : { error: 'You can only decide for your own team.' };
}
