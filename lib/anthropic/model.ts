// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { getConfigValue } from '@/lib/config';
import { BRIEFING_DEFAULT_MODEL, CLAUDE_MODEL } from './constants';

/**
 * The model used by the four original AI consumers (Intelligence Briefing,
 * anomaly detection, governance Reports, intent AI-assessment). Reads config at
 * call time; defaults to CLAUDE_MODEL (Haiku) until an admin picks another.
 */
export async function getCoreAiModel(): Promise<string> {
  return (await getConfigValue('coreAiModel')) || CLAUDE_MODEL;
}

/**
 * Organisation briefings (Cowork CIO + department briefings, the use-case
 * impact summary, and Developer Pulse briefings unless code_briefing_model is set):
 * pulse_briefing_model, else BRIEFING_DEFAULT_MODEL.
 */
export async function getOrgBriefingModel(): Promise<string> {
  return (await getConfigValue('pulseBriefingModel')) || BRIEFING_DEFAULT_MODEL;
}

/**
 * Personal weekly briefings (one per active user, the high-volume run):
 * pulse_user_briefing_model, else whatever the Core AI model is set to — read
 * at call time, so changing Core AI changes these too.
 */
export async function getUserBriefingModel(): Promise<string> {
  return (await getConfigValue('pulseUserBriefingModel')) || getCoreAiModel();
}
