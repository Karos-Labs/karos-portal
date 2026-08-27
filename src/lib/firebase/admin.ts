import "server-only";

import { initializeApp, getApps, cert, applicationDefault, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

/**
 * Server-side Firebase Admin. Credentials, in order of preference:
 *  1. FIREBASE_SERVICE_ACCOUNT_KEY (full JSON), or
 *  2. the three discrete FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY vars, or
 *  3. Application Default Credentials — keyless. Works when org policy blocks
 *     downloadable keys. Locally: `gcloud auth application-default login`.
 *     On Cloud Run: Workload Identity. Requires the project id below to be set.
 */
function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON");
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }
  return null;
}

let app: App | undefined;

function getAdminApp(): App {
  if (getApps().length) return getApps()[0]!;
  const sa = getServiceAccount();
  if (sa) {
    app = initializeApp({ credential: cert(sa as never) });
    return app;
  }

  // Keyless fallback: Application Default Credentials.
  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (projectId) {
    app = initializeApp({ credential: applicationDefault(), projectId });
    return app;
  }

  throw new Error(
    "Firebase Admin is not configured. Provide FIREBASE_SERVICE_ACCOUNT_KEY, the discrete FIREBASE_* vars, or Application Default Credentials with FIREBASE_PROJECT_ID set.",
  );
}

export const adminAuth = () => getAuth(getAdminApp());

/**
 * Returns a Google OAuth2 access token using firebase-admin's own credential
 * (google-auth-library v10, correct token endpoint). Used to authenticate direct
 * GCS REST API calls instead of going through @google-cloud/storage's nested
 * google-auth-library@9 → gtoken@7 chain that hits the deprecated v4 token URL.
 */
export async function getAdminAccessToken(): Promise<string> {
  const app = getAdminApp();
  const credential = app.options.credential;
  if (!credential) throw new Error("Firebase Admin credential is not configured");
  const result = await credential.getAccessToken();
  return result.access_token;
}

// Cache the configured Firestore on globalThis. Next.js evaluates this module in
// several runtime contexts (RSC render, route handlers, server actions) and across HMR
// reloads — each gets its own module scope but shares the Node global and the underlying
// firebase-admin Firestore singleton. A module-local cache would let `settings()` run more
// than once on that shared singleton, which throws ("settings() can only be called once").
const globalForDb = globalThis as typeof globalThis & {
  __karosAdminDb?: FirebaseFirestore.Firestore;
};

/**
 * Which Firestore database each deployment is allowed to open (AU60 / SCRUM-359).
 *
 * Keyed on the GCP PROJECT the service runs in, which is deliberately NOT the
 * Firebase project. Firebase here is one project — `karoscmo` — with two
 * databases: `(default)` is production, `prep` is prep. So every credential in
 * this system carries `project_id: karoscmo`, and asserting on that would assert
 * something trivially true that can never fail.
 *
 * `GOOGLE_CLOUD_PROJECT` is the independent signal: cloudbuild.yaml sets it from
 * `$PROJECT_ID` (the project the build runs in) and cloudbuild.promote.yaml from
 * `_GOOGLE_CLOUD_PROJECT`. It differs between environments even though the
 * Firebase project does not, so it can actually contradict the database id.
 */
const DATABASE_BY_DEPLOYMENT_PROJECT: Readonly<Record<string, string>> = {
  "karoscmo-prep": "prep",
  karoscmo: "(default)",
};

/**
 * Refuse to open the wrong database for the environment. Fails CLOSED: an
 * unrecognised deployment project throws rather than falling through to
 * `(default)`, because `(default)` here is production.
 *
 * `GOOGLE_CLOUD_PROJECT` unset means no deployment to check against — local dev
 * or a test — and is the one allowed skip.
 */
export function assertDatabaseMatchesDeployment(
  databaseId: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const project = env.GOOGLE_CLOUD_PROJECT;
  if (!project) return;

  const expected = DATABASE_BY_DEPLOYMENT_PROJECT[project];
  if (!expected) {
    throw new Error(
      `Refusing to open Firestore: unrecognised deployment project ${JSON.stringify(project)}. ` +
        `Add it to DATABASE_BY_DEPLOYMENT_PROJECT with the database it may use. Falling through ` +
        `would open "(default)", which is production.`,
    );
  }
  if (databaseId !== expected) {
    throw new Error(
      `Refusing to open Firestore database ${JSON.stringify(databaseId)} from deployment project ` +
        `${JSON.stringify(project)}, which must use ${JSON.stringify(expected)}. ` +
        `FIRESTORE_DATABASE_ID and the deployment disagree — one of them is wrong, and guessing ` +
        `would write ${databaseId === "(default)" ? "prep traffic into production" : "production traffic into prep"}.`,
    );
  }
}

export const adminDb = () => {
  if (!globalForDb.__karosAdminDb) {
    // Named-database selection — prep runs its own isolated Firestore
    // database ("prep") in the same shared Firebase project; production
    // (and anything unset) uses the project's default database.
    const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
    assertDatabaseMatchesDeployment(databaseId);
    const firestore = getFirestore(getAdminApp(), databaseId);
    try {
      // Drop undefined fields instead of throwing — optional Agent/field props
      // (e.g. a non-select field's `options`) are routinely absent on writes.
      firestore.settings({ ignoreUndefinedProperties: true });
    } catch {
      // Another module context already configured this Firestore singleton — the
      // setting is in effect, so it's safe to reuse the instance as-is.
    }
    globalForDb.__karosAdminDb = firestore;
  }
  return globalForDb.__karosAdminDb;
};

/** The default Cloud Storage bucket (from NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET). */
export function adminBucket() {
  const raw =
    process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!raw) throw new Error("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set");
  // Accept "gs://bucket", "bucket/", or a bare bucket name.
  const name = raw.replace(/^gs:\/\//, "").replace(/\/+$/, "").trim();
  return getStorage(getAdminApp()).bucket(name);
}

/** The configured bucket name, normalized — for diagnostics in error messages. */
export function adminBucketName(): string {
  return (process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "")
    .replace(/^gs:\/\//, "")
    .replace(/\/+$/, "")
    .trim();
}
