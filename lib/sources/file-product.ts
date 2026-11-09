// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The product a file was attached in (Admin → File Uploads), read from the
// cowork_sessions row that carries it: ChatGPT Chat and ChatGPT Work sessions
// are stamped by the OpenAI sync, Claude Chat conversations by Anthropic's
// Compliance API sync, and every other session is Claude Cowork (an Office or
// Google app named on its own). Client-safe: no server imports.
import { productLabel } from '@/lib/dashboard/vendor';
import { PRODUCT_LABEL, PRODUCT_FAMILY, productFullName, type WorkProduct } from '@/lib/pulse/cowork/products';

export const FILE_PRODUCTS = ['claude_cowork', 'claude_chat', 'chatgpt_chat', 'chatgpt_work'] as const;
export type FileProduct = (typeof FILE_PRODUCTS)[number];

export function isFileProduct(v: string | null | undefined): v is FileProduct {
  return !!v && (FILE_PRODUCTS as readonly string[]).includes(v);
}

/** SQL expression naming a cowork_sessions row's file product. `p` is a fixed alias such as 'cs.'. */
export function fileProductExpr(p = ''): string {
  return `CASE WHEN ${p}source = 'chatgpt_chat' THEN 'chatgpt_chat'`
    + ` WHEN ${p}source = 'chatgpt_work' THEN 'chatgpt_work'`
    + ` WHEN ${p}source = 'compliance' THEN 'claude_chat'`
    + ` ELSE 'claude_cowork' END`;
}

/** The product's name, from the session's stored `source` and `product` (an Office or Google app). */
export function fileProductLabel(product: FileProduct, app: string | null): string {
  if (product === 'claude_cowork' && app && app in PRODUCT_LABEL && PRODUCT_FAMILY[app as WorkProduct] !== 'cowork') {
    return `Claude in ${productFullName(app as WorkProduct)}`;
  }
  return productLabel(product);
}

/** The JS twin of fileProductExpr, for one row. */
export function fileProductOf(source: string | null): FileProduct {
  if (source === 'chatgpt_chat' || source === 'chatgpt_work') return source;
  if (source === 'compliance') return 'claude_chat';
  return 'claude_cowork';
}
