// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  experimental: {
    // Next.js cuts off any request body over this size when middleware runs
    // (default 10 MB) and hands the route a truncated body. For OTel ingest that
    // meant a batch over 10 MB failed to parse, answered 400, and the collector
    // dropped it. Matches INGEST_BODY_LIMIT in lib/api/body.ts, which refuses
    // anything larger with a 413.
    middlewareClientMaxBodySize: '50mb',
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
