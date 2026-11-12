import type { NextConfig } from 'next';

// The browser only ever talks to this origin; /api/* is proxied to the OpsPilot API so the
// session cookies are first-party and no CORS configuration is needed.
const target = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default config;
