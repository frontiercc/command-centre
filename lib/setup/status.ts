// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * What the dashboard's "Get started" panel shows: five setup steps, each
 * worked out from what the install already holds or marked as done by an
 * admin, plus optional steps that do not count towards the five: Claude Chat,
 * ChatGPT and Codex, and sample data on installs that ship its command.
 *
 * With only OpenAI connected (lib/sources/connected-shared.ts) there are four:
 * connecting ChatGPT and Codex replaces connecting Claude Code and Cowork,
 * which become optional.
 */
import { and, ne, isNotNull, like, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { getConnectedProducts, isOpenAiOnly } from '@/lib/sources/connected';

/** The sample organisation's people (scripts/demo/acme-people.json). */
export const SAMPLE_EMAIL_PATTERN = '%@acmecorp.example';

/** The steps' ids, as an admin marks them done. 'openai' counts only with OpenAI alone connected. */
export const SETUP_STEPS = ['api-key', 'claude-code', 'cowork', 'openai', 'rubric', 'departments'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupStatus {
  hidden: boolean;
  apiKey: boolean;
  /** Epoch seconds the first real telemetry arrived, or null. */
  claudeCodeAt: number | null;
  coworkAt: number | null;
  /** Optional steps: the first Claude Chat prompt, the first ChatGPT or Codex prompt. */
  chatAt: number | null;
  openaiAt: number | null;
  /** The tiers were saved at least once, or an admin marked them as reviewed. */
  rubricReviewed: boolean;
  departmentsSet: boolean;
  /** Steps an admin marked as done by hand. */
  markedDone: SetupStep[];
  /** Offered only where the sample data command exists (CCC_SAMPLE_DATA=1). */
  sampleData: { available: boolean; loaded: boolean };
  /** Only OpenAI is connected: ChatGPT and Codex replace Claude Code and Cowork as a required step. */
  openaiOnly: boolean;
  /** How many steps count: five, or four with only OpenAI connected. */
  total: number;
  /** Count of the required steps done. */
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

  const [hidden, key, codeAt, coworkAt, markedReviewed, stepsDone, chatAt, openaiAt, connected] = await Promise.all([
    getConfigValue('setupGuideHidden'),
    getConfigValue('anthropicAiApiKey'),
    getConfigValue('setupFirstCodeAt'),
    getConfigValue('setupFirstCoworkAt'),
    getConfigValue('setupRubricReviewed'),
    getConfigValue('setupStepsDone'),
    getConfigValue('setupFirstChatAt'),
    getConfigValue('setupFirstOpenaiAt'),
    getConnectedProducts(),
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
    chatAt: toEpoch(chatAt),
    openaiAt: toEpoch(openaiAt),
    rubricReviewed: rubricSaved || markedReviewed === 'true' || marked('rubric'),
    departmentsSet,
    markedDone,
    sampleData: { available: process.env.CCC_SAMPLE_DATA === '1', loaded: sampleLoaded },
  };
  const openaiOnly = isOpenAiOnly(connected);
  const required = openaiOnly
    ? [status.apiKey, status.openaiAt !== null || marked('openai'), status.rubricReviewed, departmentsSet]
    : [status.apiKey, status.claudeCodeAt !== null || marked('claude-code'), status.coworkAt !== null || marked('cowork'), status.rubricReviewed, departmentsSet];
  const done = required.filter(Boolean).length;
  return { ...status, openaiOnly, total: required.length, done, complete: done === required.length };
}
