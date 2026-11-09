// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Where a person was first seen (Admin → Ingestion, Recent users): the product
// of their earliest surviving prompt, or, when no prompt survives, the route
// their account arrived through. Client-safe: no server imports.
import { isProductId, productLabel } from '@/lib/dashboard/vendor';
import { PRODUCT_LABEL, PRODUCT_FAMILY, productFullName, type WorkProduct } from '@/lib/pulse/cowork/products';

/** `users.source` for each arrival route, and how it reads when no prompt survives. */
const ARRIVAL_LABEL: Record<string, string> = {
  otel: 'Claude telemetry',
  compliance: 'Anthropic Compliance API',
  openai: 'OpenAI Compliance API',
};

/** The `users.source` values the Recent users list covers. */
export const FIRST_SEEN_USER_SOURCES = Object.keys(ARRIVAL_LABEL);

/**
 * `product` is productExpr's id for the earliest prompt (null when none
 * survives); `app` is that prompt's cowork_messages.product (an Office or
 * Google app, null for Cowork itself).
 */
export function firstSeenLabel(product: string | null, app: string | null, userSource: string | null): string {
  if (product && isProductId(product)) {
    if (product === 'claude_cowork' && app && app in PRODUCT_LABEL && PRODUCT_FAMILY[app as WorkProduct] !== 'cowork') {
      return `Claude in ${productFullName(app as WorkProduct)}`;
    }
    return productLabel(product);
  }
  return ARRIVAL_LABEL[userSource ?? ''] ?? 'Claude telemetry';
}
