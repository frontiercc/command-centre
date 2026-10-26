// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// Capture-path indicator for the dashboard header: OTLP push is the path for
// Cowork and Code, Chat comes from the Compliance API on an Enterprise plan.

interface DataSourceStatus {
  coworkContent: boolean;
  otelCowork?: boolean;
  complianceApi: boolean;
  analyticsApi: boolean;
  mode: 'max' | 'enterprise';
}

export function DataSourceIndicator({ status }: { status: DataSourceStatus }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" aria-label="Data sources">
      <SourceChip label="OTel" active={Boolean(status.otelCowork)} />
      <SourceChip label="Compliance API" active={status.complianceApi} />
      <SourceChip label="Analytics API" active={status.analyticsApi} />
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
