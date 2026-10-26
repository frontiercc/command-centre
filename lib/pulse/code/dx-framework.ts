// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Optional overlay of real getDX data. Mirrors lib/finance/enterprise-cost.ts: live → guarded mock → none.
// LIVE PATH IS UNVERIFIED — no getDX test instance. fetchDxFramework() returns null until the DX Web API
// read path is wired and verified against a real DX workspace. The mock is the tested/demoed path.
import { getConfigValue } from '@/lib/config';

export interface DxDora {
  deploymentFrequencyPerWeek: number;
  leadTimeHours: number;
  changeFailureRatePct: number;
  timeToRestoreHours: number;
}
export interface DxCore4 {
  speed: number;
  quality: number;
  effectiveness: number;
  impact: number;
}
export interface DxFrameworkData {
  dora: DxDora;
  dxCore4: DxCore4;
  dxi: number | null;
}
export interface DxFrameworkResult {
  data: DxFrameworkData | null;
  source: 'live' | 'mock' | 'none';
}

// Deterministic demo fixture — plausible mid-performer. UI stamps "DEMO DATA" when source==='mock'.
export const MOCK_DX_FRAMEWORK: DxFrameworkData = {
  dora: {
    deploymentFrequencyPerWeek: 4.2,
    leadTimeHours: 26,
    changeFailureRatePct: 12,
    timeToRestoreHours: 3.5,
  },
  dxCore4: { speed: 72, quality: 68, effectiveness: 74, impact: 61 },
  dxi: 71,
};

/**
 * UNVERIFIED live adapter. The real DX read path is the DX Web API: a server-to-server HTTP RPC
 * call authenticated with a bearer org token, not the DX MCP server / DB_URL SQL path. This still needs to be
 * wired and verified against a real DX workspace before use. Until then this returns null and never
 * fabricates.
 */
export async function fetchDxFramework(): Promise<DxFrameworkData | null> {
  return null;
}

export async function getDxFramework(
  deps: { fetchLive?: () => Promise<DxFrameworkData | null> } = {}
): Promise<DxFrameworkResult> {
  const apiKey = await getConfigValue('dxApiKey');
  if (apiKey) {
    const data = await (deps.fetchLive ?? fetchDxFramework)();
    return { data, source: 'live' };
  }
  const mockEnabled = (await getConfigValue('dxFrameworkMock')) === 'true';
  const demoPermitted =
    process.env.NODE_ENV !== 'production' || process.env.CCC_DX_ALLOW_MOCK === '1';
  if (mockEnabled && demoPermitted) {
    return { data: MOCK_DX_FRAMEWORK, source: 'mock' };
  }
  return { data: null, source: 'none' };
}
