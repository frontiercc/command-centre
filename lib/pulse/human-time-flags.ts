// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Human time has one switch per surface: `humanTimeEnabled`
// for Cowork (Admin → Work Pulse) and `humanTimeCodeEnabled` for Code
// (Admin → Developer Pulse). A hub that has never set the Code switch follows the
// Cowork one, so instances that had the feature on before the split keep both.
import { getConfigValue } from '@/lib/config';
import { effectiveCodeHumanTime } from '@/lib/pulse/human-time';

export type HumanTimeSurface = 'code' | 'cowork';

export async function humanTimeOn(surface: HumanTimeSurface): Promise<boolean> {
  const cowork = await getConfigValue('humanTimeEnabled');
  if (surface === 'cowork') return cowork === 'true';
  return effectiveCodeHumanTime(await getConfigValue('humanTimeCodeEnabled'), cowork);
}
