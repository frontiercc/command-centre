// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Toolbar, Panel, Tag, Pill, B, Notice, Muted, cx } from '@/components/precision/ui';

interface Candidate {
  title: string;
  description: string;
  keywords?: string[];
  sourceExcerpt?: string;
  origin?: 'planned' | 'ideated';
  departments?: string[];
  surfaces?: string[];
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  candidates?: Candidate[];
}

type CandidateState = 'pending' | 'added' | 'ignored';

const inputCls = cx(B.input, 'w-full');

export default function IdeateChatPage() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidateStates, setCandidateStates] = useState<Record<string, CandidateState>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [mode, setMode] = useState<'scratch' | 'telemetry' | null>(null);
  const [extracting, setExtracting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const resetChat = () => {
    setMessages([]);
    setCandidateStates({});
    setInput('');
    setError(null);
    setMode(null);
  };

  // Admin gate — mirrors app/pulse/users/page.tsx
  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (!data.authenticated) { router.replace('/'); return; }
        const role = data.user?.role ?? '';
        if (role !== 'admin' && role !== 'manager') { router.replace('/'); return; }
        setChecked(true);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendWithMode = async (text: string, activeMode: 'scratch' | 'telemetry') => {
    if (!text || sending) return;
    setError(null);

    const nextHistory: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(nextHistory);
    setInput('');
    setSending(true);

    try {
      const res = await fetch('/api/use-cases/ideate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: activeMode,
          history: nextHistory.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Ideation failed');
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply, candidates: data.candidates ?? [] }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ideation failed');
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => sendWithMode(input.trim(), mode!);

  const startMode = (chosen: 'scratch' | 'telemetry') => {
    if (sending) return;
    setMode(chosen);
    const seed = chosen === 'scratch'
      ? 'Let’s brainstorm from scratch. Ask me some questions.'
      : 'Show me what my usage data suggests.';
    // send the seed as the first user turn using the chosen mode
    void sendWithMode(seed, chosen);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAdd = async (key: string, candidate: Candidate) => {
    setSavingKey(key);
    setError(null);
    try {
      const res = await fetch('/api/use-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: candidate.title,
          description: candidate.description,
          keywords: candidate.keywords ?? [],
          departments: candidate.departments ?? [],
          surfaces: candidate.surfaces ?? [],
          status: 'candidate',
          captureMethod: 'ideation',
          origin: candidate.origin ?? 'ideated',
          sourceExcerpt: candidate.sourceExcerpt ?? null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to add use case');
      setCandidateStates(prev => ({ ...prev, [key]: 'added' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add use case');
    } finally {
      setSavingKey(null);
    }
  };

  const handleIgnore = (key: string) => {
    setCandidateStates(prev => ({ ...prev, [key]: 'ignored' }));
  };

  const handleExtract = async () => {
    if (extracting || messages.length === 0) return;
    setExtracting(true);
    setError(null);
    try {
      const transcript = messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
      const res = await fetch('/api/use-cases/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Extraction failed');
      const candidates: Candidate[] = data.candidates ?? [];
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: candidates.length > 0
          ? 'Here are candidate use cases I extracted from this conversation:'
          : 'I could not extract any distinct candidate use cases from this conversation yet.',
        candidates,
      }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Extraction failed');
    } finally {
      setExtracting(false);
    }
  };

  if (!checked) {
    return (
      <>
        <TopBar title="Ideate" subtitle="Brainstorm use cases grounded in your own usage data" />
        <LoadingSpinner />
      </>
    );
  }

  return (
    <>
      <TopBar title="Ideate" subtitle="Brainstorm use cases grounded in your own usage data" />
      <PageBody>
        <Toolbar left={<Link href="/use-cases" className="text-[#245BF3] hover:underline">Back to Use Cases</Link>}>
          {mode !== null && (
            <button type="button" onClick={resetChat} disabled={sending} className={B.secondary}>
              New chat
            </button>
          )}
        </Toolbar>

        <div className="max-w-[860px] w-full flex flex-col gap-4">
          <Panel
            title="Conversation"
            right={mode !== null && messages.length > 0 ? (
              <button type="button" onClick={handleExtract} disabled={extracting || sending} className={B.accent}>
                {extracting ? 'Extracting…' : 'Extract candidates from this chat'}
              </button>
            ) : undefined}
            bodyClassName="min-h-[300px] flex flex-col gap-4"
          >
            {mode === null ? (
              <div className="flex flex-col gap-3">
                <p className="m-0 text-[14px] text-[#4D4D4D]">
                  How would you like to brainstorm? Both modes stay grounded in your own Command Centre
                  usage and your answers: never generic, never your conversation content.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => startMode('scratch')} className={B.secondary}>
                    Start from scratch
                  </button>
                  <button type="button" onClick={() => startMode('telemetry')} className={B.primary}>
                    Use my telemetry
                  </button>
                </div>
                <Muted>From scratch: I lead with questions. Use my telemetry: I lead with what your data shows.</Muted>
              </div>
            ) : null}

            <div className="flex flex-col gap-3">
              {messages.map((msg, i) => (
                <div key={i} className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <div
                    className={
                      msg.role === 'user'
                        ? 'bg-[#0A0A0A] text-white rounded-[14px] px-3.5 py-2 text-[14px] leading-6 max-w-[80%] whitespace-pre-wrap'
                        : 'bg-[#F7F7F8] border border-[#EAEAEA] text-[#0A0A0A] rounded-[14px] px-3.5 py-2 text-[14px] leading-6 max-w-[80%] whitespace-pre-wrap'
                    }
                  >
                    {msg.content}

                    {msg.candidates && msg.candidates.length > 0 && (
                      <div className="mt-3 flex flex-col gap-2">
                        {msg.candidates.map((candidate, ci) => {
                          const key = `${i}-${ci}`;
                          const state = candidateStates[key] ?? 'pending';
                          return (
                            <div key={key} className={cx('bg-white rounded-[14px] border border-[#EAEAEA] px-3 py-2.5 flex flex-col gap-1.5 whitespace-normal', state === 'ignored' && 'opacity-60')}>
                              <p className="m-0 text-[14px] font-semibold text-[#0A0A0A]">{candidate.title}</p>
                              <p className="m-0 text-[13px] text-[#4D4D4D]">{candidate.description}</p>
                              {candidate.keywords && candidate.keywords.length > 0 && (
                                <div className="flex items-center gap-1 flex-wrap">
                                  {candidate.keywords.map(k => <Tag key={k}>{k}</Tag>)}
                                </div>
                              )}
                              <div className="pt-0.5">
                                {state === 'pending' && (
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleAdd(key, candidate)}
                                      disabled={savingKey === key}
                                      className={B.primary}
                                    >
                                      {savingKey === key ? 'Adding...' : 'Add'}
                                    </button>
                                    <button type="button" onClick={() => handleIgnore(key)} className={B.secondary}>
                                      Ignore
                                    </button>
                                  </div>
                                )}
                                {state === 'added' && <Pill tone="good">Added</Pill>}
                                {state === 'ignored' && <Pill>Ignored</Pill>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {sending && <LoadingSpinner />}
              <div ref={bottomRef} />
            </div>
          </Panel>

          {error && <Notice tone="error">{error}</Notice>}

          {mode !== null && (
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about an opportunity, department, or workflow..."
                aria-label="Message"
                rows={2}
                className={inputCls}
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={sending || !input.trim()}
                className={cx(B.primary, 'shrink-0')}
              >
                Send
              </button>
            </div>
          )}
        </div>
      </PageBody>
    </>
  );
}
