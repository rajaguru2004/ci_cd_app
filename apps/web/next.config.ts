import path from 'path';
import type { NextConfig } from 'next';

/**
 * The browser only ever talks to this origin: /api/* is proxied to the NestJS API, so the
 * session cookie is first-party and there is no CORS to configure. The target is fixed at
 * build time (Docker: the `api` service on the compose network).
 *
 * A fallback rewrite, so the route handlers under app/api answer first. A plain list is an
 * afterFiles rewrite, which Next.js checks before dynamic routes: it took
 * /api/runner/v1/[...path] from its streaming handler and cut every Mac upload at 10 MB.
 */
const apiUrl = (process.env.API_INTERNAL_URL || 'http://localhost:3001').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  output: 'standalone',
  turbopack: { root: path.resolve(__dirname) },
  poweredByHeader: false,
  async rewrites() {
    return { beforeFiles: [], afterFiles: [], fallback: [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }] };
  },
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'avatars.githubusercontent.com' }],
  },
};

export default nextConfig;
