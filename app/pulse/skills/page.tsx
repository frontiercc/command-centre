// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Tool Usage has gone from Work Pulse. What it showed is elsewhere: what is spreading on the
// Dashboard, skills to try on My Pulse and the S&C Board, and "Stuck with one person" and "Used
// by nobody" on the S&C Board. An old link or bookmark lands on the S&C Board.
import { redirect } from 'next/navigation';

export default function ToolUsageMovedRedirect() {
  redirect('/library');
}
