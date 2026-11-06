// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The products Work Pulse covers: Cowork, the Claude in Office apps and the
 * Claude in Google apps. Client-safe, no imports. Stored as
 * cowork_messages.product (NULL = Cowork).
 *
 * Office and Google come from the same add-in telemetry (service.name
 * office-agent); agent.vendor tells them apart (m = Microsoft, g = Google).
 */
export const PRODUCT_ORDER = ['cowork', 'excel', 'word', 'powerpoint', 'outlook', 'sheets', 'docs', 'slides'] as const;
export type WorkProduct = typeof PRODUCT_ORDER[number];

export const PRODUCT_LABEL: Record<WorkProduct, string> = {
  cowork: 'Cowork',
  excel: 'Excel',
  word: 'Word',
  powerpoint: 'PowerPoint',
  outlook: 'Outlook',
  sheets: 'Sheets',
  docs: 'Docs',
  slides: 'Slides',
};

/** The group a product sits in on screen: Cowork, Claude in Office or Claude in Google. */
export type WorkFamily = 'cowork' | 'office' | 'google';

export const PRODUCT_FAMILY: Record<WorkProduct, WorkFamily> = {
  cowork: 'cowork',
  excel: 'office',
  word: 'office',
  powerpoint: 'office',
  outlook: 'office',
  sheets: 'google',
  docs: 'google',
  slides: 'google',
};

export const FAMILY_ORDER: readonly WorkFamily[] = ['cowork', 'office', 'google'];

export const FAMILY_LABEL: Record<WorkFamily, string> = {
  cowork: 'Cowork',
  office: 'Claude in Office',
  google: 'Claude in Google',
};

/** Products in one group, in display order. */
export function productsIn(family: WorkFamily): WorkProduct[] {
  return PRODUCT_ORDER.filter(p => PRODUCT_FAMILY[p] === family);
}

/** The app's full name where it stands alone (Audit Log, briefings): "Google Sheets", "Excel". */
export function productFullName(p: WorkProduct): string {
  return PRODUCT_FAMILY[p] === 'google' ? `Google ${PRODUCT_LABEL[p]}` : PRODUCT_LABEL[p];
}
