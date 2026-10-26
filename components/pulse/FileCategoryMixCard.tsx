// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Files by category — the mix of file types people bring into Cowork.
 *
 * Moved from /pulse/cio to /admin/files (design
 * decision). It answers "what kinds of document arrive", which is a question about
 * the file estate rather than an executive signal, and it sits naturally beside
 * the uploaded-files list it summarises. Moving it also kept the CIO grid to
 * three cards rather than wrapping to a second row.
 *
 * Extracted from app/pulse/cio/page.tsx; restyled as a Precision panel.
 * Renders nothing when there is no data, so a deployment with no uploads shows
 * no empty shell.
 */
import { Panel, BarRow, Tag } from '@/components/precision/ui';

export interface FileCategoryMixItem {
  category: string;
  count: number;
  /** 0-1 share of all categorised files. */
  share: number;
}

export default function FileCategoryMixCard({ items }: { items: FileCategoryMixItem[] }) {
  if (items.length === 0) return null;
  return (
    <Panel title="Files by category" right={<Tag tone="measured">Measured</Tag>} flush>
      <div className="py-1">
        {items.map((item) => {
          const barPct = Math.round(item.share * 100);
          return (
            <BarRow
              key={item.category}
              label={item.category}
              value={`${item.count.toLocaleString('en-GB')} (${barPct}%)`}
              pct={barPct}
              tone="measured"
            />
          );
        })}
      </div>
    </Panel>
  );
}
