// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        brand: {
          DEFAULT: "#3A58EE",
          light: "#699BFB",
          dark: "#2A3AB8",
        },
        sidebar: {
          bg: "#1C1D2F",
          hover: "#272840",
        },
        severity: {
          low: "#6B7280",
          medium: "#D97706",
          high: "#DC2626",
          critical: "#7F1D1D",
        },
      },
    },
  },
  plugins: [],
};
export default config;
