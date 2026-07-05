import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Legacy sub-project — excluded from tsc and ESLint alike
    "karolabs-data/**",
    // Standalone service with its own package.json + CI (tsc/test run there);
    // its deps aren't installed by the platform's `npm ci`.
    "agent-service/**",
  ]),
]);

export default eslintConfig;
