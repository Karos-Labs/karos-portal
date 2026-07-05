import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // agent-service is a standalone package with its own vitest + CI; its deps
    // aren't installed by the platform's npm ci, so keep its tests out of the
    // platform run (default excludes cover node_modules/dist but not this).
    exclude: ["**/node_modules/**", "**/dist/**", "agent-service/**", ".claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
