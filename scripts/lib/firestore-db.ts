/**
 * SCRUM-374 — the shared database-resolution helper for scripts/.
 *
 * Firebase here is ONE project (`karoscmo`) with TWO databases: `(default)` is
 * PRODUCTION, `prep` is prep. A bare `getFirestore()` (or `getFirestore(app)`
 * with no database argument) resolves to `(default)` — production — silently.
 * Nothing errors, because `(default)` is a real database that accepts the
 * write. `scripts/enable-v2-agents-prep.ts` is the model this generalises: it
 * refuses to run unless the operator names the database it expects, and its
 * message says the unset case "means production".
 *
 * This mirrors `assertDatabaseMatchesDeployment` in `src/lib/firebase/admin.ts`
 * (AU60 / SCRUM-359, PR #54) in spirit — fail closed, name the direction of the
 * damage — but the two guard DIFFERENT things. `admin.ts` binds the database to
 * the DEPLOYMENT (`GOOGLE_CLOUD_PROJECT`), because the portal always runs with
 * `FIRESTORE_DATABASE_ID` set by its own deploy config. A script has no
 * deployment — it runs from whatever `.env.local` a developer's shell happens
 * to have loaded — so the thing worth refusing here is DATABASE ID left unset
 * or misspelled, not a deployment/database mismatch.
 *
 * SCOPE (see SCRUM-374): this ticket does not migrate the ~30-35 scripts that
 * already call `getFirestore()` bare — changing what database each one targets
 * needs a per-script decision and is filed separately. It ships the helper, and
 * migrates the two scripts the ticket names as needing to opt in to production
 * EXPLICITLY rather than inherit it by omission: `cleanup-production-trash.ts`
 * and `audit-production-trash.ts`.
 */
import type { App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

const KNOWN_DATABASES = new Set(["(default)", "prep"]);

export interface ResolveScriptDatabaseOptions {
  /**
   * Set only by a script that is deliberately production-only by design
   * (`cleanup-production-trash.ts`, `audit-production-trash.ts`). Lets an
   * UNSET `FIRESTORE_DATABASE_ID` resolve to `(default)` instead of throwing —
   * the opt-in the ticket asks for, written into the script's own source
   * rather than left to whatever happens to be in the operator's shell.
   */
  allowDefaultProduction?: boolean;
}

/**
 * Resolve which Firestore database a script may open, refusing rather than
 * guessing. Fails CLOSED:
 *
 *  - `FIRESTORE_DATABASE_ID` set to `"(default)"` or `"prep"` → that database.
 *  - set to anything else → throws (unrecognised — refuses rather than falling
 *    through to `(default)`, which is production).
 *  - unset, and `allowDefaultProduction` is true → `"(default)"`, the one
 *    explicit opt-in this helper grants.
 *  - unset otherwise → throws. This is the actual defect SCRUM-374 filed: a
 *    bare `getFirestore()` silently resolving to production. Nothing here
 *    resolves silently.
 */
export function resolveScriptDatabaseId(
  opts: ResolveScriptDatabaseOptions = {},
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.FIRESTORE_DATABASE_ID;

  if (raw !== undefined) {
    if (!KNOWN_DATABASES.has(raw)) {
      throw new Error(
        `Refusing to open Firestore: unrecognised FIRESTORE_DATABASE_ID ${JSON.stringify(raw)}. ` +
          `Expected "(default)" (production) or "prep". Falling through would open "(default)", which is production.`,
      );
    }
    return raw;
  }

  if (opts.allowDefaultProduction) return "(default)";

  throw new Error(
    "Refusing to open Firestore: FIRESTORE_DATABASE_ID is not set. Unset means production — " +
      '"(default)" is a real database that accepts writes with nothing erroring. Set ' +
      'FIRESTORE_DATABASE_ID=prep or FIRESTORE_DATABASE_ID="(default)" explicitly. A script that is ' +
      "deliberately production-only by design opts in with { allowDefaultProduction: true }, not by " +
      "leaving this unset.",
  );
}

/**
 * `getFirestore()`, but routed through `resolveScriptDatabaseId` first so the
 * refusal happens BEFORE any Firestore instance is handed out — the same
 * on-the-path shape as `adminDb()` in `src/lib/firebase/admin.ts`.
 */
export function getScriptFirestore(
  app: App,
  opts: ResolveScriptDatabaseOptions = {},
  env: Record<string, string | undefined> = process.env,
): Firestore {
  const databaseId = resolveScriptDatabaseId(opts, env);
  return getFirestore(app, databaseId);
}
