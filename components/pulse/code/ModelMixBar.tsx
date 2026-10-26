// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Panel, PanelFoot, Tag, Muted, T, cx } from '@/components/precision/ui';
import { formatTokens } from '@/components/pulse/code/CodeStatStrip';
import { formatModelLabel } from '@/lib/pulse/code/model-label';
import { MODEL_COLOURS, MODEL_OTHER } from '@/lib/ui/chart-colours';

// One distinct colour per model, then grey for long lists (lib/ui/chart-colours).
// The six largest models get their own colour; any beyond that are grey, so no two models share a colour.
const colourAt = (i: number) => (i < MODEL_COLOURS.length ? MODEL_COLOURS[i] : MODEL_OTHER);

export interface ModelMixItem {
  model: string;
  input_tokens: number;
  output_tokens: number;
  // Optional — older callers/fixtures may omit these; treated as 0 when absent.
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  turns: number;
}

const PROVIDER_TAG_LABEL: Record<'bedrock' | 'vertex', string> = {
  bedrock: 'Bedrock',
  vertex: 'Vertex',
};

export default function ModelMixBar({ items, title = 'Model mix' }: { items: ModelMixItem[]; title?: string }) {
  // Bars/percentages below are deliberately input+output only ("conversational"
  // volume) — cache tokens are shown as a separate total, never blended into
  // the mix, since cache reads can outweigh real input/output by 100x+ on a
  // long-running session and would otherwise swamp the chart into being a
  // "which model ran longest" chart instead of a work-distribution one.
  const totals = items.map(i => ({ ...i, total: i.input_tokens + i.output_tokens }));
  const grand = totals.reduce((s, i) => s + i.total, 0);
  const cacheCreation = items.reduce((s, i) => s + (i.cache_creation_tokens ?? 0), 0);
  const cacheRead = items.reduce((s, i) => s + (i.cache_read_tokens ?? 0), 0);
  const totalCache = cacheCreation + cacheRead;

  return (
    <Panel title={title} subtitle="30 days, input and output tokens" flush>
      {grand === 0 ? (
        <div className="p-4"><Muted>No Claude Code activity captured yet.</Muted></div>
      ) : (
        <>
          <div className="px-4 pt-3.5 pb-2">
            <div className="flex h-2.5 rounded-full overflow-hidden gap-px">
              {totals.map((m, i) => {
                const { label } = formatModelLabel(m.model);
                return (
                  <div
                    key={m.model}
                    title={`${label}: ${formatTokens(m.total)} tokens`}
                    style={{ width: `${(m.total / grand) * 100}%`, backgroundColor: colourAt(i) }}
                  />
                );
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className={T.table}>
              <thead>
                <tr className={T.headRow}>
                  <th scope="col" className={T.th}>Model</th>
                  <th scope="col" className={T.thRight}>Share</th>
                  <th scope="col" className={T.thRight}>Tokens</th>
                  <th scope="col" className={T.thRight}>Turns</th>
                  {totalCache > 0 && <th scope="col" className={T.thRight}>Cache</th>}
                </tr>
              </thead>
              <tbody>
                {totals.map((m, i) => {
                  const { label, provider, estimated } = formatModelLabel(m.model);
                  const modelCache = (m.cache_creation_tokens ?? 0) + (m.cache_read_tokens ?? 0);
                  return (
                    <tr key={m.model} className={T.row}>
                      <td className={T.td}>
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colourAt(i) }} />
                          <span className="truncate">{label}</span>
                          {estimated && (
                            <Tag
                              tone="judged"
                              title="Routed via a third-party provider. Spend priced at Anthropic list rate as an estimate unless an admin has added an exact provider rate."
                            >
                              {PROVIDER_TAG_LABEL[provider as 'bedrock' | 'vertex']}
                            </Tag>
                          )}
                        </span>
                      </td>
                      <td className={T.tdRight}>{Math.round((m.total / grand) * 100)}%</td>
                      <td className={T.tdRight}>{formatTokens(m.total)}</td>
                      <td className={T.tdRight}>{m.turns.toLocaleString()}</td>
                      {totalCache > 0 && (
                        <td
                          className={cx(T.tdRight, 'text-[#8F8F8F]')}
                          title="Cache tokens for this model: billed (at a discount), not counted in the % or bar above"
                        >
                          {modelCache > 0 ? `+${formatTokens(modelCache)}` : '—'}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalCache > 0 && (
            <PanelFoot>
              Plus {formatTokens(totalCache)} cache tokens ({formatTokens(cacheRead)} read · {formatTokens(cacheCreation)} write),
              billed at a discount, not counted in the mix above.
            </PanelFoot>
          )}
        </>
      )}
    </Panel>
  );
}
