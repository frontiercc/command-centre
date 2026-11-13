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
