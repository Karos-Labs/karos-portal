import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertDatabaseMatchesDeployment } from "@/lib/firebase/admin";

/**
 * AU60 / SCRUM-359 Q1.
 *
 * Firebase here is ONE project (`karoscmo`) with TWO databases: `(default)` is
 * production, `prep` is prep. Every credential in the system therefore carries
 * `project_id: karoscmo` — so an assertion on the project would be trivially
 * true and could never fail. This binds the DATABASE to the ENVIRONMENT, via
 * `GOOGLE_CLOUD_PROJECT`, which really does differ between deployments.
 *
 * The cases that matter are the throwing ones. A guard that only ever sees its
 * happy path is the defect family this codebase has now found eight of.
 */

describe("the pairings that are correct today", () => {
  it("allows prep's project to open the prep database", () => {
    expect(() =>
      assertDatabaseMatchesDeployment("prep", { GOOGLE_CLOUD_PROJECT: "karoscmo-prep" }),
    ).not.toThrow();
  });

  it("allows production's project to open (default)", () => {
    expect(() =>
      assertDatabaseMatchesDeployment("(default)", { GOOGLE_CLOUD_PROJECT: "karoscmo" }),
    ).not.toThrow();
  });
});

describe("the pairings that would be an incident", () => {
  it("REFUSES prep's project opening production's database", () => {
    // The exact scenario Q1 was raised about: FIRESTORE_DATABASE_ID unset or
    // wrong in prep resolves to "(default)", which here IS production.
    expect(() =>
      assertDatabaseMatchesDeployment("(default)", { GOOGLE_CLOUD_PROJECT: "karoscmo-prep" }),
    ).toThrow(/must use "prep"/);
  });

  it("names the direction of the damage, not just the mismatch", () => {
    let msg = "";
    try {
      assertDatabaseMatchesDeployment("(default)", { GOOGLE_CLOUD_PROJECT: "karoscmo-prep" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("prep traffic into production");
  });

  it("REFUSES production's project opening the prep database", () => {
    expect(() =>
      assertDatabaseMatchesDeployment("prep", { GOOGLE_CLOUD_PROJECT: "karoscmo" }),
    ).toThrow(/must use "\(default\)"/);
  });
});

describe("it fails closed, not open", () => {
  it("refuses an unrecognised deployment project rather than defaulting", () => {
    // Falling through would open "(default)" — production — for an environment
    // nobody has thought about yet.
    expect(() =>
      assertDatabaseMatchesDeployment("(default)", { GOOGLE_CLOUD_PROJECT: "karoscmo-staging" }),
    ).toThrow(/unrecognised deployment project/);
  });

  it("skips only when there is no deployment to check against", () => {
    // Local dev and tests: GOOGLE_CLOUD_PROJECT unset. This is the single
    // allowed skip, and it is why the assertion does not break `npm run dev`.
    expect(() => assertDatabaseMatchesDeployment("prep", {})).not.toThrow();
    expect(() => assertDatabaseMatchesDeployment("(default)", {})).not.toThrow();
  });
});

describe("the assertion is not circular", () => {
  it("does not read FIRESTORE_DATABASE_ID — it is given the resolved id to check", () => {
    // If the guard derived the environment from the same variable it validates,
    // it could never contradict it. Setting FIRESTORE_DATABASE_ID here must not
    // rescue a mismatch.
    expect(() =>
      assertDatabaseMatchesDeployment("(default)", {
        GOOGLE_CLOUD_PROJECT: "karoscmo-prep",
        FIRESTORE_DATABASE_ID: "(default)",
      }),
    ).toThrow(/must use "prep"/);
  });
});

describe("the assertion is ON THE PATH, not merely present", () => {
  /**
   * Clause 4 of the evidence rule: a guard existing is not a guard running.
   * This drives the real `adminDb()` construction with a mismatched deployment
   * and asserts it refuses before any Firestore instance is handed out.
   */
  it("adminDb() itself refuses when the deployment and the database disagree", async () => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "karoscmo-prep");
    vi.stubEnv("FIRESTORE_DATABASE_ID", "(default)");

    const getFirestoreSpy = vi.fn(() => ({ settings: vi.fn() }));
    vi.doMock("firebase-admin/app", () => ({
      getApps: () => [{ name: "[DEFAULT]" }],
      initializeApp: () => ({ name: "[DEFAULT]" }),
      cert: () => ({}),
      applicationDefault: () => ({}),
    }));
    vi.doMock("firebase-admin/firestore", () => ({ getFirestore: getFirestoreSpy }));
    vi.doMock("firebase-admin/auth", () => ({ getAuth: () => ({}) }));
    vi.doMock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

    const mod = await import("@/lib/firebase/admin");
    expect(() => mod.adminDb()).toThrow(/must use "prep"/);
    // and it refused BEFORE constructing anything
    expect(getFirestoreSpy).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("firebase-admin/app");
    vi.doUnmock("firebase-admin/firestore");
    vi.doUnmock("firebase-admin/auth");
    vi.doUnmock("firebase-admin/storage");
  });
});
