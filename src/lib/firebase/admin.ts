import "server-only";

import { initializeApp, getApps, cert, applicationDefault, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

/**
 * Server-side Firebase Admin. Credentials, in order of preference:
 *  1. FIREBASE_SERVICE_ACCOUNT_KEY (full JSON, recommended for Vercel), or
 *  2. the three discrete FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY vars, or
 *  3. Application Default Credentials — keyless. Works when org policy blocks
 *     downloadable keys. Locally: `gcloud auth application-default login`.
 *     On Vercel/GCP: Workload Identity. Requires the project id below to be set.
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

// Cache the configured Firestore on globalThis. Next.js evaluates this module in
// several runtime contexts (RSC render, route handlers, server actions) and across HMR
// reloads — each gets its own module scope but shares the Node global and the underlying
// firebase-admin Firestore singleton. A module-local cache would let `settings()` run more
// than once on that shared singleton, which throws ("settings() can only be called once").
const globalForDb = globalThis as typeof globalThis & {
  __karosAdminDb?: FirebaseFirestore.Firestore;
};

export const adminDb = () => {
  if (!globalForDb.__karosAdminDb) {
    const firestore = getFirestore(getAdminApp());
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
