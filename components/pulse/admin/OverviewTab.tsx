// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import CapabilityQueue from '@/components/pulse/CapabilityQueue';
import PsrBaselines from '@/components/pulse/admin/PsrBaselines';
import { Panel, Figure, B, cx } from '@/components/precision/ui';
import { ToggleRow, Field, SaveMsg } from '@/components/admin/precision-admin';

interface ModuleConfig {
  pulseEnabled: string;
  pulseClassifierModel: string;
  pulseBriefingModel: string;
  /** '' = follow the Core AI model. */
  pulseUserBriefingModel: string;
  pulseSessionDescriptionsEnabled: string;
  humanTimeEnabled: string;
  coreAiModel: string;
}

interface PulseStats {
  classifiedTotal: number;
  classifiedThisWeek: number;
  failedTotal: number;
  briefingsTotal: number;
  eventsTotal: number;
}

interface OverviewTabProps {
  config: ModuleConfig;
  stats: PulseStats | null;
  saving: boolean;
  saveMsg: string | null;
  onSave: () => void;
  onConfigChange: (patch: Partial<ModuleConfig>) => void;
  onPendingCountChange: (n: number) => void;
}

const FAMILIES = ['haiku', 'sonnet', 'opus'] as const;

function ModelSelect({
  value,
  onChange,
  models,
  loading,
  followLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  models: { id: string; display_name: string }[];
  loading: boolean;
  /** When set, a first option (value '') that follows another setting. */
  followLabel?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={cx(B.select, 'w-full text-[14px] py-[7px]')}
    >
      {followLabel !== undefined && <option value="">{followLabel}</option>}
      {/* Always keep current value as a valid option so the select is never broken */}
      {loading && (
        <>
          {value !== '' && <option value={value}>{value}</option>}
          <option disabled value="__loading">Loading models…</option>
        </>
      )}
      {!loading && models.length === 0 && value !== '' && (
        <option value={value}>{value}</option>
      )}
      {!loading && models.length > 0 && (
        <>
          {FAMILIES.map(family => {
            const group = models.filter(m => m.id.toLowerCase().includes(family));
            if (!group.length) return null;
            return (
              <optgroup key={family} label={family.charAt(0).toUpperCase() + family.slice(1)}>
                {group.map(m => (
                  <option key={m.id} value={m.id}>{m.display_name || m.id}</option>
                ))}
              </optgroup>
            );
          })}
          {/* Other: models not matching any named family */}
          {(() => {
            const other = models.filter(m => !FAMILIES.some(f => m.id.toLowerCase().includes(f)));
            if (!other.length) return null;
            return (
              <optgroup key="other" label="Other">
                {other.map(m => (
                  <option key={m.id} value={m.id}>{m.display_name || m.id}</option>
                ))}
              </optgroup>
            );
          })()}
        </>
      )}
    </select>
  );
}

export default function OverviewTab({
  config, stats, saving, saveMsg, onSave, onConfigChange, onPendingCountChange,
}: OverviewTabProps) {
  const [models, setModels] = useState<{ id: string; display_name: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // Name the model "follow Core AI" resolves to right now, from the same model
  // list the selects use, so the page never shows a model the job isn't using.
  const coreAiName = config.coreAiModel
    ? (models.find(m => m.id === config.coreAiModel)?.display_name || config.coreAiModel)
    : '';
  const coreAiLabel = coreAiName ? `Follow Core AI model (${coreAiName})` : 'Follow Core AI model';

  useEffect(() => {
    fetch('/api/anthropic/models')
      .then(r => r.json())
      .then(d => setModels(d.models ?? []))
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Module settings */}
      <Panel title="Module settings" flush>
        <ToggleRow
          first
          label="Pulse enabled"
          hint="When off, the classifier and aggregator jobs do not run."
          checked={config.pulseEnabled === 'true'}
          onChange={on => onConfigChange({ pulseEnabled: on ? 'true' : 'false' })}
        />
        <ToggleRow
          label="Session descriptions"
          hint={<>One AI-written sentence on the frontier boxes saying what a piece of work was, written by the Core AI model from the session&apos;s scrubbed prompts. Admins and managers see everyone&apos;s; each person sees their own. Off stops new descriptions and hides existing ones.</>}
          checked={config.pulseSessionDescriptionsEnabled !== 'false'}
          onChange={on => onConfigChange({ pulseSessionDescriptionsEnabled: on ? 'true' : 'false' })}
        />
        <ToggleRow
          label="Human time vs Claude time · Cowork"
          hint={<>For each Tier 2 and 3 Cowork session, an AI estimate of how long the same result would take by hand, shown beside the measured time with Claude on Work Pulse, and in the weekly digest, Highlights, Reports and the Metrics Connector. Code has its own switch on Admin → Developer Pulse. Admins and managers see everyone&apos;s; each person sees their own. Off stops new Cowork estimates and hides the Cowork figures.</>}
          checked={config.humanTimeEnabled === 'true'}
          onChange={on => onConfigChange({ humanTimeEnabled: on ? 'true' : 'false' })}
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 px-4 py-3.5 border-t border-[#F2F2F2]">
          <Field label="Classifier model" hint="Used for batch classification every 5 minutes.">
            <ModelSelect
              value={config.pulseClassifierModel}
              onChange={v => onConfigChange({ pulseClassifierModel: v })}
              models={models}
              loading={modelsLoading}
            />
          </Field>
          <Field
            label="Organisation briefing model"
            hint="Used for the CIO and department briefings and use-case impact summaries. Developer Pulse briefings use it too unless Admin → Developer Pulse sets its own."
          >
            <ModelSelect
              value={config.pulseBriefingModel}
              onChange={v => onConfigChange({ pulseBriefingModel: v })}
              models={models}
              loading={modelsLoading}
            />
          </Field>
          <Field
            label="Personal briefing model"
            hint={<>Used for each person&apos;s weekly briefing, one per active user. Following the Core AI model means it changes whenever Core AI is changed on Admin → System.</>}
          >
            <ModelSelect
              value={config.pulseUserBriefingModel}
              onChange={v => onConfigChange({ pulseUserBriefingModel: v })}
              models={models}
              loading={modelsLoading}
              followLabel={coreAiLabel}
            />
          </Field>
        </div>
        <div className="flex items-center gap-3 px-4 py-3 border-t border-[#F2F2F2]">
          <button type="button" onClick={onSave} disabled={saving} className={B.primary}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <SaveMsg msg={saveMsg} />
        </div>
      </Panel>

      {/* Stats */}
      {stats && (
        <Panel title="Module status" flush>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 [&>*]:border-[#EAEAEA] [&>*]:border-t [&>*]:border-l -mt-px -ml-px">
            {[
              { label: 'Classified, total', value: stats.classifiedTotal },
              { label: 'Classified this week', value: stats.classifiedThisWeek },
              { label: 'Failed classifications', value: stats.failedTotal },
              { label: 'Briefings generated', value: stats.briefingsTotal },
              { label: 'Pulse events', value: stats.eventsTotal },
            ].map(s => (
              <Figure key={s.label} label={s.label} value={s.value.toLocaleString()} />
            ))}
          </div>
        </Panel>
      )}

      {/* On-demand briefings */}
      <Panel title="Generate briefings now" subtitle="Briefings are generated automatically. Use these controls to regenerate immediately." flush>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex-1 min-w-0">
            <p className="m-0 text-[14px] font-medium text-[#0A0A0A]">All user briefings</p>
            <p className="m-0 text-[13px] text-[#8F8F8F]">Regenerate for every user active in the past 7 days.</p>
          </div>
          <GenerateBriefingButton type="all_users" label="Generate all" />
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-t border-[#F2F2F2]">
          <div className="flex-1 min-w-0">
            <p className="m-0 text-[14px] font-medium text-[#0A0A0A]">CIO intelligence briefing</p>
            <p className="m-0 text-[13px] text-[#8F8F8F]">Regenerate the organisation-level monthly briefing.</p>
          </div>
          <GenerateBriefingButton type="cio" label="Generate CIO briefing" />
        </div>
      </Panel>

      {/* Capability queue */}
      <CapabilityQueue onCountChange={onPendingCountChange} />

      {/* PSR baselines */}
      <PsrBaselines />
    </div>
  );
}
