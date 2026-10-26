// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import { PageBody, Panel, Tag, B, cx } from '@/components/precision/ui';
import { ToggleRow, Field } from '@/components/admin/precision-admin';

// ── Shared with the Cowork/Developer Pulse admin look ─────────────────────────────
const FAMILIES = ['haiku', 'sonnet', 'opus'] as const;

function ModelSelect({
  value, onChange, models, loading, emptyLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  models: { id: string; display_name: string }[];
  loading: boolean;
  /** When set, renders a blank-value option with this label (e.g. "Use ideation model") ahead of the model list. */
  emptyLabel?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={cx(B.select, 'w-full')}
    >
      {emptyLabel && <option value="">{emptyLabel}</option>}
      {loading && (
        <>
          {!emptyLabel && <option value={value}>{value}</option>}
          <option disabled value="__loading__">Loading models…</option>
        </>
      )}
      {!loading && models.length === 0 && !emptyLabel && <option value={value}>{value}</option>}
      {!loading && models.length > 0 && (
        <>
          {FAMILIES.map(family => {
            const group = models.filter(m => m.id.toLowerCase().includes(family));
            if (!group.length) return null;
            return (
              <optgroup key={family} label={family.charAt(0).toUpperCase() + family.slice(1)}>
                {group.map(m => <option key={m.id} value={m.id}>{m.display_name || m.id}</option>)}
              </optgroup>
            );
          })}
          {(() => {
            const other = models.filter(m => !FAMILIES.some(f => m.id.toLowerCase().includes(f)));
            if (!other.length) return null;
            return (
              <optgroup key="other" label="Other">
                {other.map(m => <option key={m.id} value={m.id}>{m.display_name || m.id}</option>)}
              </optgroup>
            );
          })()}
        </>
      )}
    </select>
  );
}

export default function UseCasesAdminPage() {
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  const [models, setModels] = useState<{ id: string; display_name: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [useCasesEnabled, setUseCasesEnabled] = useState(false);
  const [useCasesExtractModel, setUseCasesExtractModel] = useState('claude-haiku-4-5-20251001');
  const [useCasesIdeateModel, setUseCasesIdeateModel] = useState('claude-sonnet-5');
  const [useCasesAdoptedMinWeeks, setUseCasesAdoptedMinWeeks] = useState('3');
  const [useCasesAdoptedMinUsers, setUseCasesAdoptedMinUsers] = useState('2');
  const [useCasesAtRiskQuietWeeks, setUseCasesAtRiskQuietWeeks] = useState('2');
  const [useCasesNotSeenQuietWeeks, setUseCasesNotSeenQuietWeeks] = useState('6');
  const [useCasesTrackerIntervalHours, setUseCasesTrackerIntervalHours] = useState('1');
  const [useCaseJudgeModel, setUseCaseJudgeModel] = useState('claude-sonnet-5');
  const [processMiningModel, setProcessMiningModel] = useState('claude-sonnet-5');
  const [useCasesSuggestExcludedSignals, setUseCasesSuggestExcludedSignals] = useState('');
  const [useCasesSuggestUseContent, setUseCasesSuggestUseContent] = useState(true);
  const [processMiningDenylist, setProcessMiningDenylist] = useState('');
  const [useCasesMinutesSavedPerSession, setUseCasesMinutesSavedPerSession] = useState('30');
  const [useCasesLoadedCompAnnual, setUseCasesLoadedCompAnnual] = useState('90000');
  const [skillDraftMinPeople, setSkillDraftMinPeople] = useState('3');
  const [skillDraftMinPrompts, setSkillDraftMinPrompts] = useState('10');
  const [skillDraftMinDays, setSkillDraftMinDays] = useState('3');
  const [skillDraftMinFollowUps, setSkillDraftMinFollowUps] = useState('3');
  const [skillDraftSoloMinDays, setSkillDraftSoloMinDays] = useState('6');
  const [skillDraftSoloMinWeeks, setSkillDraftSoloMinWeeks] = useState('4');
  const [skillDraftModel, setSkillDraftModel] = useState('claude-sonnet-5');
  const [useCasesSaving, setUseCasesSaving] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(configData => {
        setUseCasesEnabled(!!configData.useCasesEnabled);
        if (configData.useCasesExtractModel) setUseCasesExtractModel(String(configData.useCasesExtractModel));
        if (configData.useCasesIdeateModel) setUseCasesIdeateModel(String(configData.useCasesIdeateModel));
        if (configData.useCasesAdoptedMinWeeks) setUseCasesAdoptedMinWeeks(String(configData.useCasesAdoptedMinWeeks));
        if (configData.useCasesAdoptedMinUsers) setUseCasesAdoptedMinUsers(String(configData.useCasesAdoptedMinUsers));
        if (configData.useCasesAtRiskQuietWeeks) setUseCasesAtRiskQuietWeeks(String(configData.useCasesAtRiskQuietWeeks));
        if (configData.useCasesNotSeenQuietWeeks) setUseCasesNotSeenQuietWeeks(String(configData.useCasesNotSeenQuietWeeks));
        if (configData.useCasesTrackerIntervalHours) setUseCasesTrackerIntervalHours(String(configData.useCasesTrackerIntervalHours));
        if (configData.useCaseJudgeModel) setUseCaseJudgeModel(String(configData.useCaseJudgeModel));
        // Unset, the job follows the ideation model, so show that.
        setProcessMiningModel(String(configData.processMiningModel || configData.useCasesIdeateModel || 'claude-sonnet-5'));
        if (configData.useCasesSuggestExcludedSignals) {
          try {
            const parsed = JSON.parse(String(configData.useCasesSuggestExcludedSignals));
            if (Array.isArray(parsed)) setUseCasesSuggestExcludedSignals(parsed.join('\n'));
          } catch { /* ignore malformed stored value */ }
        }
        setUseCasesSuggestUseContent(configData.useCasesSuggestUseContent === 'true' || configData.useCasesSuggestUseContent === true);
        if (configData.processMiningDenylist) {
          try {
            const parsed = JSON.parse(String(configData.processMiningDenylist));
            if (Array.isArray(parsed)) setProcessMiningDenylist(parsed.join('\n'));
          } catch { /* ignore malformed stored value */ }
        }
        if (configData.useCasesMinutesSavedPerSession) setUseCasesMinutesSavedPerSession(String(configData.useCasesMinutesSavedPerSession));
        if (configData.useCasesLoadedCompAnnual) setUseCasesLoadedCompAnnual(String(configData.useCasesLoadedCompAnnual));
        if (configData.skillDraftMinPeople) setSkillDraftMinPeople(String(configData.skillDraftMinPeople));
        if (configData.skillDraftMinPrompts) setSkillDraftMinPrompts(String(configData.skillDraftMinPrompts));
        if (configData.skillDraftMinDays) setSkillDraftMinDays(String(configData.skillDraftMinDays));
        if (configData.skillDraftMinFollowUps) setSkillDraftMinFollowUps(String(configData.skillDraftMinFollowUps));
        if (configData.skillDraftSoloMinDays) setSkillDraftSoloMinDays(String(configData.skillDraftSoloMinDays));
        if (configData.skillDraftSoloMinWeeks) setSkillDraftSoloMinWeeks(String(configData.skillDraftSoloMinWeeks));
        if (configData.skillDraftModel !== undefined) setSkillDraftModel(String(configData.skillDraftModel));
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    fetch('/api/anthropic/models')
      .then(r => r.json())
      .then(d => setModels(d.models ?? []))
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, []);

  const handleSaveUseCases = async () => {
    setUseCasesSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          useCasesEnabled: String(useCasesEnabled),
          useCasesExtractModel,
          useCasesIdeateModel,
          useCasesAdoptedMinWeeks,
          useCasesAdoptedMinUsers,
          useCasesAtRiskQuietWeeks,
          useCasesNotSeenQuietWeeks,
          useCasesTrackerIntervalHours,
          useCaseJudgeModel,
          processMiningModel,
          useCasesSuggestExcludedSignals: JSON.stringify(
            useCasesSuggestExcludedSignals.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
          ),
          useCasesSuggestUseContent: String(useCasesSuggestUseContent),
          // Empty stays '' (not '[]') so the code-defined default denylist keeps
          // applying until an admin actually enters phrases — see processMiningDenylist
          // in lib/config.ts.
          processMiningDenylist: (() => {
            const parsed = processMiningDenylist.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
            return parsed.length ? JSON.stringify(parsed) : '';
          })(),
          useCasesMinutesSavedPerSession,
          useCasesLoadedCompAnnual,
          skillDraftMinPeople,
          skillDraftMinPrompts,
          skillDraftMinDays,
          skillDraftMinFollowUps,
          skillDraftSoloMinDays,
          skillDraftSoloMinWeeks,
          skillDraftModel,
        }),
      });
      if (res.ok) {
        showToast('Use Cases settings saved', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save Use Cases settings', 'error');
      }
    } catch {
      showToast('Failed to save Use Cases settings', 'error');
    } finally {
      setUseCasesSaving(false);
    }
  };


  if (loading) return (
    <>
      <TopBar title="Use Cases" subtitle="Capture, register, and track AI use cases against real telemetry" />
      <LoadingSpinner />
    </>
  );

  const numInput = cx(B.input, 'w-full tabular-nums');

  return (
    <>
      <TopBar title="Use Cases" subtitle="Capture, register, and track AI use cases against real telemetry" />
      <PageBody className="max-w-[1000px]">

        {/* Enable & models */}
        <Panel title="Enable and models" flush>
          <ToggleRow
            first
            label="Enable Use Cases"
            hint="Capture, register, and track the AI use cases your organisation cares about, matched against real telemetry."
            checked={useCasesEnabled}
            onChange={setUseCasesEnabled}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-4 py-3.5 border-t border-[#F2F2F2]">
            <Field label="Extraction model" hint="Used for transcript-based candidate extraction.">
              <ModelSelect value={useCasesExtractModel} onChange={setUseCasesExtractModel} models={models} loading={modelsLoading} />
            </Field>
            <Field label="Ideation model" hint="Used for the brainstorm and ideation chatbot.">
              <ModelSelect value={useCasesIdeateModel} onChange={setUseCasesIdeateModel} models={models} loading={modelsLoading} />
            </Field>
          </div>
        </Panel>

        {/* Lifecycle */}
        <Panel title="Lifecycle" flush>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
            <Field label="Adopted: min active weeks (of 4)">
              <input
                type="number"
                min={1}
                max={4}
                value={useCasesAdoptedMinWeeks}
                onChange={(e) => setUseCasesAdoptedMinWeeks(e.target.value)}
                className={numInput}
              />
            </Field>
            <Field label="Adopted: min distinct users">
              <input
                type="number"
                min={1}
                value={useCasesAdoptedMinUsers}
                onChange={(e) => setUseCasesAdoptedMinUsers(e.target.value)}
                className={numInput}
              />
            </Field>
            <Field label="At risk after quiet weeks">
              <input
                type="number"
                min={1}
                value={useCasesAtRiskQuietWeeks}
                onChange={(e) => setUseCasesAtRiskQuietWeeks(e.target.value)}
                className={numInput}
              />
            </Field>
            <Field label="Not-seen decay after quiet weeks">
              <input
                type="number"
                min={1}
                value={useCasesNotSeenQuietWeeks}
                onChange={(e) => setUseCasesNotSeenQuietWeeks(e.target.value)}
                className={numInput}
              />
            </Field>
          </div>
          <div className="px-4 py-3.5 border-t border-[#F2F2F2]">
            <Field
              label="Tracker cadence (hours)"
              hint="How often adoption stages are refreshed from the judged sessions. Sessions themselves are judged hourly."
              className="max-w-[320px]"
            >
              <input
                type="number"
                min={1}
                value={useCasesTrackerIntervalHours}
                onChange={(e) => setUseCasesTrackerIntervalHours(e.target.value)}
                className={cx(B.input, 'w-32 tabular-nums')}
              />
            </Field>
          </div>
        </Panel>

        {/* Suggestions */}
        <Panel title="Suggestions and judging" flush>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
            <Field
              className="md:col-span-2"
              label="Session judging model"
              hint="Reads each finished session and judges which use cases it is doing. Sonnet 5 by default; it was validated on real data before release."
            >
              <ModelSelect
                value={useCaseJudgeModel}
                onChange={setUseCaseJudgeModel}
                models={models}
                loading={modelsLoading}
              />
            </Field>
            <Field
              className="md:col-span-2"
              label="Department process model"
              hint="Reads each department's prompts once a week and suggests the recurring jobs it finds. Sonnet 5 by default."
            >
              <ModelSelect
                value={processMiningModel}
                onChange={setProcessMiningModel}
                models={models}
                loading={modelsLoading}
              />
            </Field>
            <Field
              className="md:col-span-2"
              label="Commodity skills left out of clues"
              hint="Skills and connectors too common to help recognise a process (Word, PowerPoint and the like). Left off a mined use case's clues. One per line or comma-separated."
            >
              <textarea
                value={useCasesSuggestExcludedSignals}
                onChange={(e) => setUseCasesSuggestExcludedSignals(e.target.value)}
                rows={3}
                placeholder="anthropic-skills:docx&#10;anthropic-skills:pptx&#10;basic_drafting"
                className={cx(B.input, 'w-full font-mono')}
              />
            </Field>
          </div>
          <ToggleRow
            label="Content analysis (on by default)"
            ariaLabel="Content analysis"
            hint="Lets Claude read prompts, PII-scrubbed first, to find each department's repeated work and to judge which use case each session is doing. Off: no new suggestions and no judging, so tracking pauses, except sessions that run a use case's own skill."
            checked={useCasesSuggestUseContent}
            onChange={setUseCasesSuggestUseContent}
          />
          <div className="px-4 py-3.5 border-t border-[#F2F2F2]">
            <Field
              label="Process suggestion denylist"
              hint="Generic, tool-shaped titles that must never surface as department process opportunities. JSON array of phrases."
            >
              <textarea
                value={processMiningDenylist}
                onChange={(e) => setProcessMiningDenylist(e.target.value)}
                rows={3}
                placeholder="reporting&#10;drafting&#10;spreadsheet analysis"
                className={cx(B.input, 'w-full font-mono')}
              />
            </Field>
          </div>
        </Panel>

        {/* Skill drafting — readiness bar */}
        <Panel
          title="Skill drafting"
          subtitle={<>How much evidence a confirmed use case needs before &ldquo;Turn this into a skill&rdquo; is offered</>}
          flush
        >
          <p className="m-0 px-4 pt-3.5 text-[13px] text-[#B54708] leading-5">
            Proposed defaults, not yet measured against a live department. Raise or lower once real drafts have been reviewed.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
            {[
              ['Minimum people', skillDraftMinPeople, setSkillDraftMinPeople, 'Distinct people whose prompts matched the use case.'],
              ['Minimum distinct prompts', skillDraftMinPrompts, setSkillDraftMinPrompts, 'After collapsing duplicates.'],
              ['Minimum separate days', skillDraftMinDays, setSkillDraftMinDays, 'Distinct UTC days with matching prompts.'],
              ['Minimum follow-ups', skillDraftMinFollowUps, setSkillDraftMinFollowUps, 'Prompts after the first in a session, where people say what good looks like.'],
              ['Single-owner: minimum days', skillDraftSoloMinDays, setSkillDraftSoloMinDays, 'When only one person does the work.'],
              ['Single-owner: minimum weeks spanned', skillDraftSoloMinWeeks, setSkillDraftSoloMinWeeks, 'First to last matching prompt.'],
            ].map(([label, value, setter, hint]) => (
              <Field key={label as string} label={label as string} hint={hint as string}>
                <input type="number" min={1} value={value as string}
                  onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                  className={numInput} />
              </Field>
            ))}
            <Field
              className="md:col-span-2"
              label="Drafting model"
              hint="Model that writes the skill draft. Only this capability uses it; everything else stays on the Core AI model set on Admin → System."
            >
              <ModelSelect
                value={skillDraftModel}
                onChange={setSkillDraftModel}
                models={models}
                loading={modelsLoading}
              />
            </Field>
          </div>
        </Panel>

        {/* Governance value (estimate) */}
        <Panel
          title="Governance value"
          badge={<Tag tone="judged">Estimate</Tag>}
          flush
        >
          <p className="m-0 px-4 pt-3.5 text-[14px] text-[#666666] leading-5">
            Calibrates the <span className="text-[#2451F3]">estimated</span> hours and $ recovered shown on the
            Use Case Governance rollup. These are estimates built on measured session counts, never presented as measured fact.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
            <Field label="Minutes saved per matched session">
              <input type="number" min={1} value={useCasesMinutesSavedPerSession}
                onChange={(e) => setUseCasesMinutesSavedPerSession(e.target.value)}
                className={numInput} />
            </Field>
            <Field
              label="Annual loaded cost per person ($)"
              hint="$ value = hours recovered × (this ÷ 1800 working hours/year)."
            >
              <input type="number" min={0} value={useCasesLoadedCompAnnual}
                onChange={(e) => setUseCasesLoadedCompAnnual(e.target.value)}
                className={numInput} />
            </Field>
          </div>
        </Panel>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSaveUseCases}
            disabled={useCasesSaving}
            className={B.primary}
          >
            {useCasesSaving ? 'Saving...' : 'Save settings'}
          </button>
        </div>

      </PageBody>
    </>
  );
}
