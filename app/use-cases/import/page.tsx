// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useRef, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Toolbar, Panel, Tag, Pill, B, Notice, Empty, cx } from '@/components/precision/ui';

interface Candidate {
  title: string;
  description: string;
  departments?: string[];
  surfaces?: string[];
  keywords?: string[];
  sourceExcerpt: string;
  origin: 'planned' | 'ideated';
}

const ORIGIN_LABEL: Record<Candidate['origin'], string> = {
  planned: 'Planned',
  ideated: 'Ideated',
};

type CandidateState = 'pending' | 'added' | 'ignored';

const inputCls = cx(B.input, 'w-full');

const TEXT_EXTS = /\.(txt|md|vtt)$/i;
const BINARY_EXTS = /\.(pdf|docx)$/i;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

interface FileData {
  base64: string;
  name: string;
  mediaType: string;
}

// Read a File as raw base64 (no data: prefix). readAsDataURL avoids the
// call-stack blow-up that btoa(String.fromCharCode(...)) hits on large files.
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function ImportTranscriptPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [checked, setChecked] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [states, setStates] = useState<Record<number, CandidateState>>({});
  const [savingIndex, setSavingIndex] = useState<number | null>(null);

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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    // Reset the input so re-selecting the same file re-fires onChange.
    e.target.value = '';

    if (file.size > MAX_FILE_BYTES) {
      setError(`File is too large (max ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB)`);
      return;
    }

    if (TEXT_EXTS.test(file.name)) {
      try {
        const text = await file.text();
        setTranscript(text);
        setFileData(null);
        setFileName(file.name);
      } catch {
        setError('Could not read that file');
      }
      return;
    }

    if (BINARY_EXTS.test(file.name)) {
      try {
        const base64 = await readAsBase64(file);
        setFileData({ base64, name: file.name, mediaType: file.type || '' });
        setTranscript('');
        setFileName(file.name);
      } catch {
        setError('Could not read that file');
      }
      return;
    }

    setError('Unsupported file type. Choose a .txt, .md, .vtt, .pdf, or .docx file.');
  };

  const handleExtract = async () => {
    setError(null);
    if (!fileData && !transcript.trim()) {
      setError('Paste a transcript or choose a file first');
      return;
    }
    setExtracting(true);
    setCandidates(null);
    setStates({});
    try {
      const payload = fileData
        ? { fileBase64: fileData.base64, fileName: fileData.name, mediaType: fileData.mediaType }
        : { transcript };
      const res = await fetch('/api/use-cases/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Extraction failed');
      setCandidates(data.candidates ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Extraction failed');
    } finally {
      setExtracting(false);
    }
  };

  const handleAdd = async (index: number) => {
    const candidate = candidates?.[index];
    if (!candidate) return;
    setSavingIndex(index);
    try {
      const res = await fetch('/api/use-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: candidate.title,
          description: candidate.description,
          departments: candidate.departments ?? [],
          surfaces: candidate.surfaces ?? [],
          keywords: candidate.keywords ?? [],
          origin: candidate.origin,
          status: 'candidate',
          captureMethod: 'transcript',
          sourceExcerpt: candidate.sourceExcerpt,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to add use case');
      setStates(prev => ({ ...prev, [index]: 'added' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add use case');
    } finally {
      setSavingIndex(null);
    }
  };

  const handleIgnore = (index: number) => {
    setStates(prev => ({ ...prev, [index]: 'ignored' }));
  };

  if (!checked) {
    return (
      <>
        <TopBar title="Import Transcript" subtitle="Extract candidate use cases from a transcript" />
        <LoadingSpinner />
      </>
    );
  }

  return (
    <>
      <TopBar title="Import Transcript" subtitle="Extract candidate use cases from a transcript" />
      <PageBody>
        <Toolbar left={<Link href="/use-cases" className="text-[#245BF3] hover:underline">Back to Use Cases</Link>} />

        <div className="max-w-[860px] w-full flex flex-col gap-4">
          <Panel title="Transcript" flush>
            <div className="p-4 flex flex-col gap-3">
              <textarea
                value={transcript}
                onChange={e => { setTranscript(e.target.value); setFileName(null); setFileData(null); }}
                placeholder="Paste a meeting or workshop transcript here..."
                aria-label="Transcript"
                rows={10}
                className={inputCls}
              />

              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={B.secondary}
                >
                  Choose file (.txt, .md, .vtt, .pdf, .docx)
                </button>
                {fileName && <span className="text-[13px] text-[#666666] font-mono">{fileName}</span>}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,.vtt,.pdf,.docx"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>

              {fileData && (
                <p className="m-0 text-[13px] text-[#666666]">
                  Ready to extract from <span className="font-medium text-[#0A0A0A]">{fileData.name}</span>. The file&rsquo;s contents aren&rsquo;t shown above; we&rsquo;ll read them when you extract.
                </p>
              )}

              {error && <Notice tone="error">{error}</Notice>}
            </div>
            <div className="px-4 py-3 border-t border-[#F2F2F2]">
              <button type="button" onClick={handleExtract} disabled={extracting} className={B.accent}>
                {extracting ? 'Extracting...' : 'Extract candidates'}
              </button>
            </div>
          </Panel>

          {extracting && <LoadingSpinner />}

          {candidates && !extracting && (
            candidates.length === 0 ? (
              <Empty title="No use cases found in this transcript." />
            ) : (
              <Panel
                title="Candidates"
                subtitle={<span className="tabular-nums">{candidates.length} candidate{candidates.length === 1 ? '' : 's'} found</span>}
                right={<Tag tone="judged">AI-extracted</Tag>}
                flush
              >
                {candidates.map((candidate, index) => {
                  const state = states[index] ?? 'pending';
                  return (
                    <div
                      key={index}
                      className={cx('flex items-start gap-4 px-4 py-3 border-t border-[#F2F2F2] first:border-t-0', state === 'ignored' && 'opacity-50')}
                    >
                      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="m-0 text-[14px] font-semibold text-[#0A0A0A]">{candidate.title}</p>
                          <Tag>{ORIGIN_LABEL[candidate.origin]}</Tag>
                        </div>
                        <p className="m-0 text-[14px] text-[#4D4D4D]">{candidate.description}</p>
                        <blockquote className="m-0 text-[13px] text-[#8F8F8F] italic border-l-2 border-[#EAEAEA] pl-2">
                          &ldquo;{candidate.sourceExcerpt}&rdquo;
                        </blockquote>
                        {((candidate.departments ?? []).length > 0 || (candidate.surfaces ?? []).length > 0) && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {(candidate.departments ?? []).map(d => (
                              <span key={d} className="text-[13px] text-[#4D4D4D] bg-[#F2F2F2] rounded-[6px] px-1.5 py-0.5">{d}</span>
                            ))}
                            {(candidate.surfaces ?? []).map(s => <Tag key={s}>{s}</Tag>)}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {state === 'pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleAdd(index)}
                              disabled={savingIndex === index}
                              className={B.primary}
                            >
                              {savingIndex === index ? 'Adding...' : 'Add'}
                            </button>
                            <button type="button" onClick={() => handleIgnore(index)} className={B.secondary}>
                              Ignore
                            </button>
                          </>
                        )}
                        {state === 'added' && <Pill tone="good">Added</Pill>}
                        {state === 'ignored' && <Pill>Ignored</Pill>}
                      </div>
                    </div>
                  );
                })}
              </Panel>
            )
          )}
        </div>
      </PageBody>
    </>
  );
}
