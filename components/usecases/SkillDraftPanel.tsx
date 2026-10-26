// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// "Turn this into a skill". Reads the additive
// `skillDraft` view from GET /api/use-cases/[id]; every count shown is
// measured by the server. The draft itself is authored text and is labelled
// as such — neither measured (blue) nor estimated (violet).
'use client';

import { useEffect, useRef, useState } from 'react';
import { sectionCitationCounts } from '@/lib/usecases/skill-draft-validate';
import { Panel, PanelFoot, SubHead, Pill, B, Notice, Muted, cx } from '@/components/precision/ui';

interface Gap { key: string; label: string; have: number; need: number }
interface Stats { prompts: number; distinctPrompts: number; people: number; sessions: number; days: number; followUps: number; weeksSpanned: number; unreadableSessions: number; promptsShown?: number }
interface OwnerQuestion { q: string; done: boolean }
interface Draft {
  skillName: string; description: string; bodyMd: string; ownerQuestions: OwnerQuestion[];
  citations: Record<string, number[]>; corpusStats: Stats; thin: boolean; model: string;
  generatedAt: number; editedAt: number | null; downloadedAt: number | null; libraryEntryId: number | null;
}
export interface SkillDraftView {
  readiness: { ready: boolean; mode: 'team' | 'solo' | null; missing: Gap[] };
  stats: Stats;
  contentOn: boolean;
  draft: Draft | null;
}

interface Props { view: SkillDraftView; useCaseId: string; onChanged: (view: SkillDraftView) => void }

const MEASURED_CLS = 'text-[#05073F]';
const FIELD_LABEL = 'block text-[13px] font-medium text-[#4D4D4D] mb-1';

// Every count is the FULL matched evidence; the model reads a capped sample,
// said plainly when it is smaller. `sampleWording` differs before and after a draft exists.
function evidenceLine(s: Stats, sampleWording: string): string {
  const parts = [`${s.prompts} prompts`, `${s.people} ${s.people === 1 ? 'person' : 'people'}`, `${s.days} separate days`, `${s.followUps} follow-ups`];
  const shown = s.promptsShown;
  const sample = shown !== undefined && shown < s.prompts ? ` · ${sampleWording} ${shown}` : '';
  return parts.join(' · ') + ' · last 13 weeks' + sample;
}

const NETWORK_ERROR = 'Something went wrong talking to the server. Try again.';


/**
 * The one message shown when a generated skill is refused by the validator
 * (approved wording). The validator's reasons are audited server-side
 * and never shown raw here.
 */
export const DRAFT_FAILURE_MESSAGE = "We don't have enough prompt data to make the skill yet, please come back later.";

export function describeDraftFailure(_reasons: string[]): string {
  void _reasons;
  return DRAFT_FAILURE_MESSAGE;
}

/** A thrown model call (no key, network, Anthropic error) is a service fault, not a refused draft. */
export const MODEL_UNAVAILABLE_MESSAGE = 'The AI service did not respond. Ask an admin to check the Anthropic API key under Admin → System.';

function groundingWord(count: number): { word: string; tone: 'good' | 'neutral' | 'warn' } {
  if (count >= 4) return { word: 'strong', tone: 'good' };
  if (count >= 1) return { word: 'some', tone: 'neutral' };
  return { word: 'none', tone: 'warn' };
}

// How long Cancel keeps polling for the in-flight draft the abort couldn't
// actually stop server-side (the POST keeps running once dispatched).
const CANCEL_POLL_MS = 5000;
const CANCEL_POLL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Whether a draft found while polling after Cancel is the one THIS cancel
 * started (and therefore safe to auto-discard) rather than some other draft —
 * e.g. a fresh, deliberate one from a later mount of this same panel, or from
 * another tab on the same use case. `startedAt`/`cancelledAt` bracket the
 * cancelled attempt's own lifetime (a 5s grace before the POST for clock
 * skew, a 180s grace after Cancel for the server to finish writing); an
 * edited draft is always deliberate regardless of timing.
 */
export function shouldDeleteAfterCancel(
  draft: { generatedAt: number; downloadedAt: number | null; editedAt: number | null },
  startedAt: number,
  cancelledAt: number,
  nowS: number
): boolean {
  void nowS;
  if (draft.downloadedAt !== null) return false;
  if (draft.editedAt !== null) return false;
  if (draft.generatedAt < startedAt - 5) return false;
  if (draft.generatedAt > cancelledAt + 180) return false;
  return true;
}

export default function SkillDraftPanel({ view, useCaseId, onChanged }: Props) {
  const [busy, setBusy] = useState<'draft' | 'save' | 'download' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saveVersion, setSaveVersion] = useState(0);
  const [cancelStatus, setCancelStatus] = useState<'idle' | 'cancelling' | 'cancelled'>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledAtRef = useRef(0);
  const draft = view.draft;
  const api = `/api/use-cases/${encodeURIComponent(useCaseId)}/skill-draft`;

  // Stop the cancel poll dead on unmount — navigating away and back remounts
  // the panel fresh, and without this the orphaned poll from the old mount
  // keeps running against the same `api` URL and can delete the new mount's
  // deliberate draft (the bug this cleanup + the identity check below fix).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      pollAbortRef.current?.abort();
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  async function refresh() {
    const r = await fetch(api);
    if (r.ok) { const v = (await r.json()) as SkillDraftView; onChanged(v); }
  }

  async function generate(replace: boolean) {
    if (replace && draft?.editedAt && !window.confirm('Regenerate replaces your edits. Continue?')) return;
    setBusy('draft'); setError(null); setCancelStatus('idle');
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now() / 1000;
    try {
      const r = await fetch(api + (replace ? '?replace=1' : ''), { method: 'POST', signal: controller.signal });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.error === 'generation_failed'
          ? describeDraftFailure(Array.isArray(body.reasons) ? (body.reasons as string[]) : [])
          : body.error === 'model_unavailable' ? MODEL_UNAVAILABLE_MESSAGE
          : body.error === 'not_ready' ? 'Not enough evidence yet.' : body.error === 'content_off' ? 'Content analysis is switched off.' : 'Drafting failed.');
        return;
      }
      setEditorOpen(false);
      await refresh();
    } catch {
      if (controller.signal.aborted) { await pollAfterCancel(startedAt, cancelledAtRef.current); } else { setError(NETWORK_ERROR); }
    } finally {
      if (mountedRef.current) setBusy(null);
      abortRef.current = null;
    }
  }

  // Aborting the client fetch does not stop the server-side draft — it keeps
  // running. Poll until a not-yet-downloaded draft shows up, then discard it
  // so the user lands back on the ready state, exactly as if they'd never
  // clicked — but ONLY the draft this cancel actually started
  // (shouldDeleteAfterCancel), and only while this component is still
  // mounted. Without both checks, navigating away and back (a fresh mount)
  // and clicking "Turn this into a skill" again leaves this poll running
  // against the same `api` URL; it would find the new, deliberate draft and
  // delete it. Two tabs open on the same use case inside the same
  // three-minute window are a residual race this cannot distinguish — a
  // deliberate draft started in the OTHER tab looks identical — left
  // unsolved on purpose.
  async function pollAfterCancel(startedAt: number, cancelledAt: number) {
    const controller = new AbortController();
    pollAbortRef.current = controller;
    try {
      const deadline = Date.now() + CANCEL_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise<void>(resolve => { pollTimerRef.current = setTimeout(resolve, CANCEL_POLL_MS); });
        pollTimerRef.current = null;
        if (!mountedRef.current || controller.signal.aborted) return;
        let r: Response;
        try {
          r = await fetch(api, { signal: controller.signal });
        } catch {
          continue;
        }
        if (!mountedRef.current || controller.signal.aborted) return;
        if (!r.ok) continue;
        const v = (await r.json()) as SkillDraftView;
        if (!mountedRef.current || controller.signal.aborted) return;
        if (v.draft && shouldDeleteAfterCancel(v.draft, startedAt, cancelledAt, Date.now() / 1000)) {
          await fetch(api, { method: 'DELETE', signal: controller.signal }).catch(() => {});
          if (!mountedRef.current) return;
          await refresh();
          setCancelStatus('cancelled');
          idleTimerRef.current = setTimeout(() => { if (mountedRef.current) setCancelStatus('idle'); }, 2500);
          return;
        }
        if (v.draft) { onChanged(v); setCancelStatus('idle'); return; }
      }
      if (mountedRef.current) { await refresh(); setCancelStatus('idle'); }
    } finally {
      pollAbortRef.current = null;
    }
  }

  function cancelDrafting() {
    cancelledAtRef.current = Date.now() / 1000;
    setCancelStatus('cancelling');
    abortRef.current?.abort();
  }

  async function discardDraft() {
    if (!window.confirm('Discard this draft? Nothing has been published.')) return;
    setBusy('discard'); setError(null);
    try {
      const r = await fetch(api, { method: 'DELETE' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.error === 'downloaded' ? 'This skill has already been published. Use Regenerate instead.' : 'Discard failed.');
        return;
      }
      await refresh();
    } catch { setError(NETWORK_ERROR); } finally { setBusy(null); }
  }

  async function save(patch: Partial<Pick<Draft, 'skillName' | 'description' | 'bodyMd' | 'ownerQuestions'>>) {
    setBusy('save'); setError(null);
    try {
      const r = await fetch(api, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setError(body.error === 'name_taken' ? 'That skill name is already taken on the Skills and Connectors Board.' : (body.reasons as string[] | undefined)?.join('; ') ?? 'Save failed.'); return; }
      await refresh();
    } catch { setError(NETWORK_ERROR); } finally { setBusy(null); setSaveVersion(v => v + 1); }
  }

  // Download is a fetch, not a plain <a href>, because the zip route can answer
  // 409 name_taken — a bare link would hand the user a JSON error body instead
  // of a readable message in the panel.
  async function downloadZip() {
    if (!draft) return;
    setBusy('download'); setError(null);
    try {
      const r = await fetch(`${api}/zip`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as Record<string, unknown>));
        setError(body.error === 'name_taken' ? 'That skill name is already taken on the Skills and Connectors Board. Rename it first.' : 'Download failed.');
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${draft.skillName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await refresh();
    } catch { setError(NETWORK_ERROR); } finally { setBusy(null); }
  }

  // --- States ---------------------------------------------------------------
  if (!view.contentOn) {
    return (
      <Panel title="Skill">
        <Muted>Skill drafting needs the content-informed suggestions switch on (<code className="font-mono">/admin/use-cases</code>).</Muted>
      </Panel>
    );
  }

  const headerActions = !draft ? (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button type="button" className={cx(B.accent, 'whitespace-nowrap shrink-0')} disabled={!view.readiness.ready || busy === 'draft'} onClick={() => generate(false)}>
          {busy === 'draft' ? 'Drafting…' : 'Turn this into a skill'}
        </button>
        {busy === 'draft' && (
          <button type="button" className={cx(B.secondary, 'whitespace-nowrap shrink-0')} disabled={cancelStatus === 'cancelling'} onClick={cancelDrafting}>
            {cancelStatus === 'cancelling' ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>
    </div>
  ) : undefined;

  const draftingNote = !draft && (
    <>
      {busy === 'draft' && cancelStatus !== 'cancelling' && (
        <Muted>Drafting from {view.stats.promptsShown ?? view.stats.prompts} prompts. Usually a minute or two.</Muted>
      )}
      {busy === 'draft' && cancelStatus === 'cancelling' && (
        <Muted>Cancelled. Tidying up in the background.</Muted>
      )}
      {busy !== 'draft' && cancelStatus === 'cancelled' && <Muted>Cancelled.</Muted>}
    </>
  );

  if (!draft) {
    return (
      <Panel title="Skill" subtitle="Draft an Agent Skill from how this department already does the work." right={headerActions}>
        <div className="flex flex-col gap-2">
          {draftingNote}
          {view.readiness.ready ? (
            <p className={cx('m-0 text-[14px] tabular-nums', MEASURED_CLS)}>{evidenceLine(view.stats, 'the draft reads a sample of')}</p>
          ) : (
            <div className="text-[14px] text-[#333333]">
              <span className="font-medium">Not ready yet:</span>{' '}
              <span className="tabular-nums">{view.readiness.missing.map(m => `${m.have} of ${m.need} ${m.label}`).join(' · ')}</span>
              <p className="m-0 mt-1 text-[13px] text-[#8F8F8F]">Needs several people, several days and the follow-up prompts where people say what good looks like. Thresholds are on the use cases admin page.</p>
            </div>
          )}
          {view.stats.unreadableSessions > 0 && (
            <Muted>{view.stats.unreadableSessions} matched session{view.stats.unreadableSessions === 1 ? ' is' : 's are'} past the content retention window and cannot be read.</Muted>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      </Panel>
    );
  }

  const counts = sectionCitationCounts(draft.bodyMd, draft.citations);
  // Download is live the moment a draft exists. The earlier
  // read-first gate (disabled until the editor had been opened) confused a tester
  // twice: the button just looked broken, with only a hover tooltip to say why.

  return (
    <Panel title="Skill" subtitle="Draft an Agent Skill from how this department already does the work." flush>
      <div className="p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Pill>Draft: review before use</Pill>
          {draft.thin && <Pill tone="warn">Built from a small share of the evidence</Pill>}
          {draft.downloadedAt !== null && <Pill tone="good">Codified · on the Skills and Connectors Board · awaiting first use</Pill>}
        </div>

        {draft.ownerQuestions.length > 0 && (
          <div>
            <SubHead>For the owner to settle</SubHead>
            <ul className="m-0 p-0 list-none flex flex-col gap-1">
              {draft.ownerQuestions.map((oq, i) => (
                <li key={i}>
                  <label className="flex items-start gap-2 text-[14px] text-[#333333]">
                    <input type="checkbox" className="mt-1 accent-[#0A0A0A]" checked={oq.done} disabled={busy !== null}
                      onChange={e => save({ ownerQuestions: draft.ownerQuestions.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)) })} />
                    <span className={oq.done ? 'line-through text-[#8F8F8F]' : ''}>{oq.q}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className={FIELD_LABEL}>Skill name</span>
            <input className={cx(B.input, 'w-full font-mono')} defaultValue={draft.skillName} key={`name-${saveVersion}`} disabled={busy !== null}
              onBlur={e => { if (busy !== null) return; const v = e.target.value.trim(); if (v && v !== draft.skillName) save({ skillName: v }); }} />
          </label>
          <div className="text-[13px] text-[#8F8F8F] self-end">
            This name is what usage is matched on once the skill is in the library. Lowercase, hyphens only.
          </div>
        </div>

        <label className="block">
          <span className={FIELD_LABEL}>Description (what it does and when to use it)</span>
          <textarea className={cx(B.input, 'w-full')} rows={3} defaultValue={draft.description} key={`d-${saveVersion}`} disabled={busy !== null}
            onBlur={e => { if (busy !== null) return; if (e.target.value !== draft.description) save({ description: e.target.value }); }} />
        </label>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[13px] font-medium text-[#4D4D4D]">Skill body</span>
            <button type="button" className={B.link} onClick={() => setEditorOpen(o => !o)} aria-expanded={editorOpen}>{editorOpen ? 'Collapse' : 'Open editor'}</button>
          </div>
          <div className="flex flex-wrap gap-1 mb-2">
            {counts.map(c => { const g = groundingWord(c.count); return (
              <span key={c.section} title={`${c.count} prompt${c.count === 1 ? '' : 's'} cited`}>
                <Pill tone={g.tone}>{c.section}: {g.word}</Pill>
              </span>
            ); })}
          </div>
          {editorOpen && (
            <textarea className={cx(B.input, 'w-full font-mono')} rows={28} defaultValue={draft.bodyMd} key={`b-${saveVersion}`} disabled={busy !== null}
              onBlur={e => { if (busy !== null) return; if (e.target.value !== draft.bodyMd) save({ bodyMd: e.target.value }); }} />
          )}
          <p className="m-0 mt-1 text-[13px] text-[#8F8F8F]">Sections: {counts.map(c => c.section).join(' · ')}. Keep every section.</p>
        </div>

        {error && <Notice tone="error">{error}</Notice>}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-[#F2F2F2]">
        <button type="button" className={B.primary} disabled={busy !== null} onClick={downloadZip}>
          {busy === 'download' ? 'Downloading…' : 'Download zip'}
        </button>
        <button type="button" className={B.secondary} disabled={busy !== null} onClick={() => generate(true)}>Regenerate</button>
        {draft.downloadedAt === null && (
          <button type="button" className={B.danger} disabled={busy !== null} onClick={discardDraft}>
            {busy === 'discard' ? 'Discarding…' : 'Discard draft'}
          </button>
        )}
        {draft.libraryEntryId !== null && (
          <a className={cx(B.link, 'ml-1')} href={`/library/${draft.libraryEntryId}`}>View on the Skills and Connectors Board</a>
        )}
        <span className={cx('ml-auto text-[13px] tabular-nums', MEASURED_CLS)}>{evidenceLine(draft.corpusStats, 'drafted from a sample of')}</span>
      </div>
      <PanelFoot>
        Drafted {new Date(draft.generatedAt * 1000).toLocaleDateString('en-GB')} on {draft.model}
        {draft.editedAt ? ` · edited ${new Date(draft.editedAt * 1000).toLocaleDateString('en-GB')}` : ''}.
        Upload the zip in Organisation settings → Plugins &amp; skills. Usage is tracked here from the first time it is used.
      </PanelFoot>
    </Panel>
  );
}
