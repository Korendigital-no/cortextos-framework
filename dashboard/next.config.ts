import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Next.js 15.2+ blocks non-localhost origins from /_next/* dev-internal
// resources by default. When the dashboard is accessed over Tailscale, a LAN
// IP, or a reverse proxy, the browser receives the SSR HTML but the client
// bundle cannot finish hydrating because dev-resource requests are rejected —
// useEffect never fires, the CSRF token is never fetched, and the login form
// is stuck.
//
// Set DASHBOARD_ALLOWED_DEV_ORIGINS to a comma-separated list of hostnames or
// IPs to whitelist (e.g. "100.64.95.40,mybox.local,dashboard.example.com").
// Localhost is always allowed. Only reads in development; production builds
// ignore the setting.
const allowedDevOrigins = (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Dist-dir isolation (task_1780688854348): builds/dev write SEPARATE dirs
  // (.next-build / .next-dev via env from package.json scripts); the serve
  // dir .next is only ever touched by the prestart swap in ensure-built.sh
  // (service-stopped context). Closes the split-brain class where a local
  // build overwrote the directory a running next-server was serving from
  // (2026-06-05 prod incident: new-disk HTML + old-memory asset manifest
  // -> CSS 404, unstyled dashboard).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['better-sqlite3'],
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
  async redirects() {
    return [
      // Research moved from a CRM sub-route to a top-level page. Preserve old
      // bookmarks/links with a permanent (308) redirect.
      { source: '/crm/research', destination: '/research', permanent: true },
    ];
  },
  async headers() {
    return [
      {
        // Prevent aggressive caching of API routes and pages through the tunnel
        source: '/((?!_next/static).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
});
