// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// Capture-path indicator for the dashboard header: OTLP push is the path for
// Cowork and Code, Chat comes from the Compliance API on an Enterprise plan,
// and ChatGPT and Codex from OpenAI's Compliance API. Each source is listed with
// whether it is on (its key saved, or for OpenTelemetry, data received). With only
// OpenAI connected the Claude paths are not shown; with ChatGPT and Codex hidden
// in Admin, OpenAI's is not.

import { useOpenAiOnly } from '@/components/shared/VendorSwitch';

interface DataSourceStatus {
  coworkContent: boolean;
  otelCowork?: boolean;
  complianceApi: boolean;
  analyticsApi: boolean;
  openai?: boolean;
  openaiShown?: boolean;
  mode: 'max' | 'enterprise';
}

export function DataSourceIndicator({ status }: { status: DataSourceStatus }) {
  const openaiOnly = useOpenAiOnly();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" aria-label="Data sources">
      {!openaiOnly && (
        <>
          <SourceChip label="OpenTelemetry" active={Boolean(status.otelCowork)} />
          <SourceChip label="Anthropic Compliance API" active={status.complianceApi} />
          <SourceChip label="Anthropic Analytics API" active={status.analyticsApi} />
        </>
      )}
      {(status.openaiShown !== false || openaiOnly) && <SourceChip label="OpenAI Compliance API" active={Boolean(status.openai)} />}
    </div>
  );
}

function SourceChip({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[10px] border border-[#EAEAEA] bg-white px-2 py-0.5 text-[13px] ${
        active ? 'text-[#0A0A0A]' : 'text-[#8F8F8F]'
      }`}
      title={active ? `${label}: connected` : `${label}: not connected`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-[#1A7F37]' : 'bg-[#D4D4D4]'}`} aria-hidden="true" />
      {label}
    </span>
  );
}
