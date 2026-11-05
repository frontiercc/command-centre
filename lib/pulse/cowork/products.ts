// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The products Work Pulse covers: Cowork and the Claude in Office apps.
 * Client-safe, no imports. Stored as cowork_messages.product (NULL = Cowork).
 */
export const PRODUCT_ORDER = ['cowork', 'excel', 'word', 'powerpoint', 'outlook'] as const;
export type WorkProduct = typeof PRODUCT_ORDER[number];

export const PRODUCT_LABEL: Record<WorkProduct, string> = {
  cowork: 'Cowork',
  excel: 'Excel',
  word: 'Word',
  powerpoint: 'PowerPoint',
  outlook: 'Outlook',
};
