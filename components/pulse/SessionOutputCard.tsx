// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// "What did the work produce?": the share of sessions that produced something, by week and by
// kind of work, as the Work Pulse overview receives it (lib/pulse/cowork/session-output-rate.ts).

export interface SessionOutputWeek {
  weekStart: number;
  sessions: number;
  produced: number;
  rate: number | null;
}

export interface SessionOutputByTaskType {
  taskType: string;
  sessions: number;
  produced: number;
  rate: number;
}

export interface SessionOutputReport {
  hasData: boolean;
  sessions: number;
  produced: number;
  rate: number | null;
  weeks: SessionOutputWeek[];
  byTaskType?: SessionOutputByTaskType[];
  /** True once ChatGPT is connected: the figure covers Claude sessions only. */
  claudeOnly?: boolean;
}
