// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Heroicons (MIT); see THIRD-PARTY-NOTICES.md.

'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Tag, B } from '@/components/precision/ui';

interface Report {
  id: string;
  report_type: string;
  period_start: string;
  period_end: string;
  generated_by: string | null;
  content_md: string;
  content_summary: string | null;
  generated_at: number;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatPeriod(start: string, end: string): string {
  const s = new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const e = new Date(end).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `${s} to ${e}`;
}

function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export default function ReportViewer({
  report,
  onBack,
}: {
  report: Report;
  onBack: () => void;
}) {
  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] overflow-hidden min-w-0">
      {/* Header */}
      <div className="px-6 py-5 border-b border-[#EAEAEA] flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex flex-col gap-1">
          <span className="text-[13px] text-[#8F8F8F]">Frontier Command Centre</span>
          <h2 className="m-0 text-[18px] font-semibold tracking-[-0.02em] text-[#0A0A0A]">
            {sentenceCase(report.report_type)} governance report
          </h2>
          <span className="text-[13px] text-[#666666]">
            {formatPeriod(report.period_start, report.period_end)}
          </span>
        </div>
        <div className="ml-auto flex flex-col items-end gap-2 text-[13px] text-[#8F8F8F]">
          <span>Generated {formatDate(report.generated_at)} · By {report.generated_by || 'system'}</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => window.print()} className={B.primary}>
              Export PDF
            </button>
            <button type="button" onClick={onBack} className={B.secondary}>
              Back to list
            </button>
          </div>
        </div>
      </div>

      {/* Executive summary highlight */}
      {report.content_summary && (
        <div className="mx-6 mt-5 border border-[#EAEAEA] bg-[#FAFAFA] rounded-[14px] px-4 py-3 flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h3 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">Executive summary</h3>
            <Tag tone="judged">AI summary</Tag>
          </div>
          <p className="m-0 text-[14px] text-[#333333] leading-[1.6]">{report.content_summary}</p>
        </div>
      )}

      {/* Report body */}
      <div className="px-6 py-6">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => (
              <h1 className="text-[16px] font-semibold text-[#0A0A0A] border-b border-[#EAEAEA] pb-2.5 mb-4 mt-8 first:mt-0">
                {children}
              </h1>
            ),
            h2: ({ children }) => {
              const text = String(children);
              // Audit section boxes
              if (text.includes('Cowork Audit') || text.includes('Code Audit') || text.includes('Chat Audit')) {
                return (
                  <div className="mt-8 mb-3 border border-[#EAEAEA] bg-[#FAFAFA] rounded-[14px] px-4 py-2.5 flex items-center gap-2">
                    <svg aria-hidden="true" width={16} height={16} className="shrink-0 text-[#8F8F8F]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                    </svg>
                    <h2 className="m-0 text-[15px] font-semibold text-[#0A0A0A]">{children}</h2>
                  </div>
                );
              }
              // Recommendations section
              if (text.includes('Recommended Actions') || text.includes('Recommendations')) {
                return (
                  <h2 className="text-[15px] font-semibold text-[#0A0A0A] mt-8 mb-3">{children}</h2>
                );
              }
              return (
                <h2 className="text-[15px] font-semibold text-[#0A0A0A] mt-8 mb-3 pt-5 border-t border-[#F2F2F2]">
                  {children}
                </h2>
              );
            },
            h3: ({ children }) => (
              <h3 className="text-[14px] font-semibold text-[#0A0A0A] mt-5 mb-2">{children}</h3>
            ),
            p: ({ children }) => (
              <p className="text-[14px] text-[#333333] leading-[1.6] mb-3">{children}</p>
            ),
            strong: ({ children }) => (
              <strong className="font-semibold text-[#0A0A0A]">{children}</strong>
            ),
            em: ({ children }) => (
              <em className="text-[#666666] italic">{children}</em>
            ),
            ul: ({ children }) => (
              <ul className="my-3 ml-5 space-y-1.5 list-disc marker:text-[#B3B3B3]">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="my-3 ml-5 space-y-1.5 list-decimal marker:text-[#8F8F8F]">{children}</ol>
            ),
            li: ({ children }) => (
              <li className="text-[14px] text-[#333333] leading-[1.6] pl-1">{children}</li>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border border-[#EAEAEA] bg-[#FAFAFA] rounded-[10px] py-2.5 px-3.5 my-4 text-[14px] text-[#4D4D4D]">
                {children}
              </blockquote>
            ),
            code: ({ children }) => (
              <code className="bg-[#F2F2F2] px-1.5 py-0.5 rounded-[6px] text-[13px] font-mono text-[#333333]">{children}</code>
            ),
            hr: () => <hr className="my-6 border-[#EAEAEA]" />,
            // Table components — explicit styling since prose classes are unreliable in Docker build
            table: ({ children }) => (
              <div className="my-4 overflow-x-auto rounded-[14px] border border-[#EAEAEA]">
                <table className="w-full border-collapse text-[14px]">{children}</table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="text-left border-b border-[#EAEAEA] bg-[#FAFAFA]">{children}</thead>
            ),
            tbody: ({ children }) => (
              <tbody>{children}</tbody>
            ),
            tr: ({ children }) => (
              <tr className="border-t border-[#F2F2F2] first:border-t-0 hover:bg-[#FAFAFA]">{children}</tr>
            ),
            th: ({ children }) => (
              <th className="px-3 py-2 text-left text-[13px] font-medium text-[#8F8F8F] whitespace-nowrap">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-2.5 text-[14px] text-[#333333] align-top tabular-nums">
                {children}
              </td>
            ),
          }}
        >
          {report.content_md}
        </ReactMarkdown>
      </div>

      {/* Footer */}
      <div className="border-t border-[#EAEAEA] px-6 py-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-[#8F8F8F]">
        <span>
          Frontier Command Centre · Report ID: <span className="font-mono">{report.id.slice(0, 8)}</span>
        </span>
        <span>Generated by AI analysis · {formatDate(report.generated_at)}</span>
      </div>
    </section>
  );
}
