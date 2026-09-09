import type { NextConfig } from "next";

/**
 * Response headers every route carries.
 *
 * The portal is an authenticated app behind a session cookie, and until this
 * existed it shipped with NO browser hardening headers at all: it could be
 * framed by any origin (clickjacking a logged-in staff session), it announced
 * its framework, and it left MIME sniffing and referrer leakage to browser
 * defaults. Nothing in the app needs to be framed by another site, so the
 * frame policy is the strictest one.
 *
 * `Content-Security-Policy` is deliberately limited to `frame-ancestors`: a
 * full script/style policy needs nonces threaded through Next's inline
 * hydration scripts and Tailwind's inline styles, which is a project of its
 * own — and a half-applied one silently breaks pages. `frame-ancestors` is the
 * one directive with no such coupling, and it is the one `X-Frame-Options`
 * cannot express for multiple origins (kept as the legacy fallback).
 *
 * HSTS is safe to send unconditionally: Cloud Run terminates TLS, so every
 * production request already arrived over HTTPS, and a plain-HTTP local dev
 * server ignores the header by spec (browsers only honour HSTS over TLS).
 */
const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The portal uses none of these; denying them means a compromised script
  // cannot silently ask for them either.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  // Emit a self-contained Node.js server in .next/standalone.
  // Required for Docker / Cloud Run — copies only the minimal files needed to run.
  output: "standalone",

  // The `X-Powered-By: Next.js` header is free reconnaissance for an attacker
  // and helps nobody else.
  poweredByHeader: false,

  // Pin the workspace root to this project (a stray lockfile lives in the home dir).
  // Only affects `next dev` (Turbopack); ignored during `next build`.
  turbopack: {
    root: __dirname,
  },

  experimental: {
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },

  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;
