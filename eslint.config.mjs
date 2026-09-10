import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // The codebase's own convention for "intentionally unused" (a param kept
      // for a stable signature, a destructured field excluded on purpose) is a
      // leading underscore with a comment explaining why — see buildGapViews's
      // _clientId in seo-geo/presenter.ts and _omitted in client-agent-runs.test.ts.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
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
