// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * What the dashboard's "Get started" panel shows: five setup steps, each
 * worked out from what the install already holds or marked as done by an
 * admin, plus an optional sample data step on installs that ship the sample
 * data command.
 */
import { and, ne, isNotNull, like, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';

/** The sample organisation's people (scripts/demo/acme-people.json). */
export const SAMPLE_EMAIL_PATTERN = '%@acmecorp.example';

/** The five steps' ids, as an admin marks them done. */
export const SETUP_STEPS = ['api-key', 'claude-code', 'cowork', 'rubric', 'departments'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupStatus {
  hidden: boolean;
  apiKey: boolean;
  /** Epoch seconds the first real telemetry arrived, or null. */
  claudeCodeAt: number | null;
  coworkAt: number | null;
  /** The tiers were saved at least once, or an admin marked them as reviewed. */
  rubricReviewed: boolean;
  departmentsSet: boolean;
  /** Steps an admin marked as done by hand. */
  markedDone: SetupStep[];
  /** Offered only where the sample data command exists (CCC_SAMPLE_DATA=1). */
  sampleData: { available: boolean; loaded: boolean };
  /** Count of the five required steps done. */
  done: number;
  complete: boolean;
}

const toEpoch = (v: string): number | null => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : null;
};

/** The stored list of steps marked done, ignoring anything that is not a known step. */
export function parseStepsDone(raw: string): SetupStep[] {
  try {
    const list: unknown = JSON.parse(raw || '[]');
    return Array.isArray(list) ? SETUP_STEPS.filter((s) => list.includes(s)) : [];
  } catch {
    return [];
  }
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const client = await getTypedClient();
  const exists = async (q: Promise<unknown[]>) => (await q).length > 0;

  const [hidden, key, codeAt, coworkAt, markedReviewed, stepsDone] = await Promise.all([
    getConfigValue('setupGuideHidden'),
    getConfigValue('anthropicAiApiKey'),
    getConfigValue('setupFirstCodeAt'),
    getConfigValue('setupFirstCoworkAt'),
    getConfigValue('setupRubricReviewed'),
    getConfigValue('setupStepsDone'),
  ]);
  const markedDone = parseStepsDone(stepsDone);
  const marked = (step: SetupStep) => markedDone.includes(step);
  const au = schema.adminUsers;
  const us = schema.users;
  // A department counts on either kind of account: the admin user pages save
  // it on the users table, sign-in accounts carry their own.
  const [rubricSaved, adminDept, userDept, sampleLoaded] = await Promise.all([
    exists(client.select({ x: sql`1` }).from(schema.pulseRubricVersions).limit(1)),
    exists(client.select({ x: sql`1` }).from(au)
      .where(and(isNotNull(au.department), ne(sql`trim(${au.department})`, ''))).limit(1)),
    exists(client.select({ x: sql`1` }).from(us)
      .where(and(isNotNull(us.department), ne(sql`trim(${us.department})`, ''))).limit(1)),
    exists(client.select({ x: sql`1` }).from(schema.users).where(like(schema.users.email, SAMPLE_EMAIL_PATTERN)).limit(1)),
  ]);

  const departmentsSet = adminDept || userDept || marked('departments');

  const status = {
    hidden: hidden === 'true',
    apiKey: key.length > 0 || marked('api-key'),
    claudeCodeAt: toEpoch(codeAt),
    coworkAt: toEpoch(coworkAt),
    rubricReviewed: rubricSaved || markedReviewed === 'true' || marked('rubric'),
    departmentsSet,
    markedDone,
    sampleData: { available: process.env.CCC_SAMPLE_DATA === '1', loaded: sampleLoaded },
  };
  const done = [status.apiKey, status.claudeCodeAt !== null || marked('claude-code'), status.coworkAt !== null || marked('cowork'), status.rubricReviewed, departmentsSet]
    .filter(Boolean).length;
  return { ...status, done, complete: done === 5 };
}
