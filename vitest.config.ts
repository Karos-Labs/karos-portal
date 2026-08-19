import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // agent-service is a standalone package with its own vitest + CI; its deps
    // aren't installed by the platform's npm ci, so keep its tests out of the
    // platform run (default excludes cover node_modules/dist but not this).
    exclude: ["**/node_modules/**", "**/dist/**", "agent-service/**", ".claude/**"],
    // The default 5000ms is too tight for this directory's source-sweeping
    // suites (full-tree readdirSync/readFileSync walks, several driving the
    // TypeScript compiler) once several run concurrently and contend for CPU —
    // a slow machine timed those suites out nondeterministically even though
    // nothing was actually wrong. 30s gives real hangs room to still fail loud.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
