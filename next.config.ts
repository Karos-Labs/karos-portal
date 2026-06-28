import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained Node.js server in .next/standalone.
  // Required for Docker / Cloud Run — copies only the minimal files needed to run.
  output: "standalone",

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
};

export default nextConfig;
