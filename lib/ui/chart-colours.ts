// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Chart colours, in one place: "calm editorial". Products
 * indigo, teal and rose; models in earth tones; percentage bars charcoal. Each group is its own
 * colour family, so a product is never mistaken for a model and single-value bars don't compete
 * with coloured series. Tiers stay a sky-blue ramp, because sky blue means AI-judged.
 * Client-safe, no imports.
 */

/** Chat, Code and Cowork. Teal and rose are a shade deeper than the mockup so white text passes AA. */
export const SURFACE_COLOR = {
  cowork: '#3F3D9E', // indigo
  code: '#0D8276',   // teal
  chat: '#B9507A',   // rose
} as const;

/** Text colour that reads on a full-strength surface fill. */
export const SURFACE_INK = {
  cowork: '#FFFFFF',
  code: '#FFFFFF',
  chat: '#FFFFFF',
} as const;

/**
 * One colour per model, most expensive first: earth tones alternating dark and light so
 * neighbouring segments in a split bar never blend. "Other / unpriced" stays grey.
 */
export const MODEL_COLOURS = ['#5B4B2E', '#B98A3E', '#D9C9A3', '#8A6F45', '#CFAE72', '#EDE3CC'] as const;
export const MODEL_OTHER = '#B3B3B3';

/** Single-series percentage and share bars (cost by type, shares, top lists): charcoal. */
export const SHARE_BAR = '#3D4451';
