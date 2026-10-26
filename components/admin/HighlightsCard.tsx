// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Notice, B, cx } from '@/components/precision/ui';
import { ToggleRow } from '@/components/admin/precision-admin';

interface HighlightsStatus {
  enabled: boolean;
  model: string;
  includeNames: boolean;
  slackConfigured: boolean;
}

interface PreviewResult {
  post: string;
  weekStart: number;
  weekEnd: number;
  deliverableCount: number;
}

function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export default function HighlightsCard() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [enabledSaving, setEnabledSaving] = useState(false);
  const [model, setModel] = useState('claude-sonnet-5');
  const [modelSaving, setModelSaving] = useState(false);
  const [includeNames, setIncludeNames] = useState(false);
  const [includeNamesSaving, setIncludeNamesSaving] = useState(false);
  const [slackConfigured, setSlackConfigured] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [weekRange, setWeekRange] = useState<{ start: number; end: number } | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirmingSend, setConfirmingSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [saveError, setSaveError] = useState<string | null>(null);

  const loadStatus = () => {
    fetch('/api/admin/highlights')
      .then((r) => r.json())
      .then((data: HighlightsStatus) => {
        setEnabled(!!data.enabled);
        setModel(data.model || 'claude-sonnet-5');
        setIncludeNames(!!data.includeNames);
        setSlackConfigured(!!data.slackConfigured);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const saveKey = async (key: string, value: string) => {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
    return res.ok;
  };

  /** Clears every piece of generated-draft state — used when the admin turns the feature off, so a
   * stale draft (possibly containing named shout-outs) can never resurface with live Copy/Send
   * buttons after re-enabling without regenerating. */
  const resetDraftState = () => {
    setDraft('');
    setWeekRange(null);
    setInfoMessage(null);
    setErrorMessage(null);
    setSendResult(null);
    setConfirmingSend(false);
  };

  const handleToggleEnabled = async (next: boolean) => {
    setEnabledSaving(true);
    setSaveError(null);
    try {
      const ok = await saveKey('highlightsEnabled', next ? 'true' : 'false');
      if (ok) {
        setEnabled(next);
        if (!next) resetDraftState();
      } else {
        setSaveError('Failed to save. Try again.');
      }
    } catch {
      setSaveError('Failed to save: network error.');
    } finally {
      setEnabledSaving(false);
    }
  };

  const handleSaveModel = async () => {
    setModelSaving(true);
    setSaveError(null);
    try {
      const ok = await saveKey('highlightsModel', model);
      if (!ok) setSaveError('Failed to save model. Try again.');
    } catch {
      setSaveError('Failed to save model: network error.');
    } finally {
      setModelSaving(false);
    }
  };

  const handleToggleIncludeNames = async (next: boolean) => {
    setIncludeNamesSaving(true);
    setSaveError(null);
    try {
      const ok = await saveKey('highlightsIncludeNames', next ? 'true' : 'false');
      if (ok) {
        setIncludeNames(next);
      } else {
        setSaveError('Failed to save. Try again.');
      }
    } catch {
      setSaveError('Failed to save: network error.');
    } finally {
      setIncludeNamesSaving(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setInfoMessage(null);
    setErrorMessage(null);
    setSendResult(null);
    try {
      const res = await fetch('/api/admin/highlights/preview');
      const data = await res.json();
      if (res.status === 422) {
        setInfoMessage(data.message || 'No highlights can be written for last week.');
        setDraft('');
        setWeekRange(null);
        return;
      }
      if (!res.ok) {
        setErrorMessage(data.message || data.error || "Couldn't generate the draft. Try again.");
        setDraft('');
        setWeekRange(null);
        return;
      }
      const result = data as PreviewResult;
      setDraft(result.post);
      setWeekRange({ start: result.weekStart, end: result.weekEnd });
    } catch {
      setErrorMessage('Failed to generate draft: network error');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — silently ignore, button just doesn't flip */
    }
  };

  const handleSend = async () => {
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch('/api/admin/highlights/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: draft }),
      });
      const data = await res.json();
      if (res.ok) {
        setSendResult({ ok: true, message: 'Posted to Slack.' });
      } else {
        setSendResult({ ok: false, message: data.error || "Couldn't send. Try again." });
      }
    } catch {
      setSendResult({ ok: false, message: 'Failed to send: network error' });
    } finally {
      setSending(false);
      setConfirmingSend(false);
    }
  };


  if (loading) return null;

  return (
    <Panel title="Weekly highlights" flush>
      <ToggleRow
        first
        label="Enable weekly highlights"
        hint={<>A model-drafted &quot;what the week produced&quot; post from last week&apos;s real work: generate, edit, then copy or send. Never scheduled, never sent unreviewed.</>}
        ariaLabel="Enable weekly highlights"
        checked={enabled}
        onChange={handleToggleEnabled}
        disabled={enabledSaving}
      />

      {saveError && (
        <div className="px-4 pb-3">
          <Notice tone="error">{saveError}</Notice>
        </div>
      )}

      {enabled && (
        <>
          <div className="px-4 py-3 border-t border-[#F2F2F2]">
            <div className="flex flex-col gap-1.5 max-w-xl">
              <label htmlFor="highlights-model" className="text-[14px] font-medium text-[#0A0A0A]">Model</label>
              <div className="flex gap-2">
                <input
                  id="highlights-model"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className={cx(B.input, 'flex-1 min-w-0')}
                  placeholder="claude-sonnet-5"
                />
                <button
                  type="button"
                  onClick={handleSaveModel}
                  disabled={modelSaving}
                  className={cx(B.primary, 'shrink-0')}
                >
                  {modelSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>

          <ToggleRow
            label="Include named shout-outs"
            hint="Names your own staff in the post. Off by default."
            checked={includeNames}
            onChange={handleToggleIncludeNames}
            disabled={includeNamesSaving}
          />

          <div className="px-4 py-3 border-t border-[#F2F2F2] flex flex-col gap-3">
            {infoMessage && <Notice tone="warn">{infoMessage}</Notice>}
            {errorMessage && <Notice tone="error">{errorMessage}</Notice>}

            <div>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                className={B.accent}
              >
                {generating ? 'Generating…' : 'Generate draft'}
              </button>
            </div>
          </div>

          {draft && (
            <div className="px-4 py-3 border-t border-[#F2F2F2] flex flex-col gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={14}
                aria-label="Weekly highlights draft"
                className={cx(B.input, 'w-full font-mono leading-5')}
              />
              {weekRange && (
                <p className="m-0 text-[13px] text-[#8F8F8F] leading-5">
                  Draft covers {fmtDate(weekRange.start)}–{fmtDate(weekRange.end)}. Edit freely: what you copy or send is exactly what is in this box. Model-written sentences are <span className="text-[#2451F3]">judged</span>; every number is <span className="text-[#245BF3]">measured</span>.
                </p>
              )}

              {sendResult && (
                <Notice tone={sendResult.ok ? 'success' : 'error'}>{sendResult.message}</Notice>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button type="button" onClick={handleCopy} className={B.secondary}>
                  {copied ? 'Copied' : 'Copy'}
                </button>

                {!slackConfigured && (
                  <>
                    <button
                      type="button"
                      disabled
                      title="Configure a Slack webhook under Weekly digest above to enable sending."
                      className={B.secondary}
                    >
                      Send to Slack
                    </button>
                    <span className="text-[13px] text-[#8F8F8F]">
                      Send disabled: configure a Slack webhook under Weekly digest above.
                    </span>
                  </>
                )}

                {slackConfigured && !confirmingSend && (
                  <button
                    type="button"
                    onClick={() => setConfirmingSend(true)}
                    disabled={sending}
                    className={B.secondary}
                  >
                    Send to Slack
                  </button>
                )}

                {slackConfigured && confirmingSend && (
                  <span className="inline-flex flex-wrap items-center gap-2 text-[14px]">
                    <span className="text-[#333333]">Post to the configured Slack channel?</span>
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={sending}
                      className={B.primary}
                    >
                      {sending ? 'Sending…' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingSend(false)}
                      disabled={sending}
                      className={B.secondary}
                    >
                      Cancel
                    </button>
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
