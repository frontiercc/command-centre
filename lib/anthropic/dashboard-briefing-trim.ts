// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { splitSentences } from '@/lib/anthropic/recommendation-text';
/**
 * Last-resort trim for the dashboard briefing (createGroundedJson's `trim`), used only after the
 * model's reply has been refused twice for an unchecked number. It keeps everything that passes
 * and drops only what carries an unchecked number, so the page shows a briefing instead of an
 * error (on 3 October two first loads failed on one invented figure each). createGroundedJson
 * checks the result again before it is used, so nothing unchecked is ever shown. Pure.
 */

export interface TrimmableBriefing {
  briefing: string;
  risk_reasoning?: string;
  adoption_headline?: string;
  recommendations: Array<{ title?: string; detail?: string }>;
}

/** Fewest briefing sentences and recommendations worth showing. */
export const MIN_BRIEFING_SENTENCES = 2;
export const MIN_RECOMMENDATIONS = 3;

const sentences = splitSentences;

export function trimDashboardBriefing<T extends TrimmableBriefing>(value: T, isClean: (text: string) => boolean): T | null {
  const kept = sentences(value.briefing).filter(isClean);
  if (kept.length < MIN_BRIEFING_SENTENCES) return null;

  const recommendations = value.recommendations.filter(r => isClean(r.title ?? '') && isClean(r.detail ?? ''));
  if (recommendations.length < MIN_RECOMMENDATIONS) return null;

  const reasoning = sentences(value.risk_reasoning ?? '').filter(isClean).join(' ');
  const headline = value.adoption_headline && isClean(value.adoption_headline) ? value.adoption_headline : '';

  return { ...value, briefing: kept.join(' '), risk_reasoning: reasoning, adoption_headline: headline, recommendations };
}
