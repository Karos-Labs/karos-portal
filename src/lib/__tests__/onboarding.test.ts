import { describe, expect, it } from "vitest";
import { needsOnboarding, shouldBlockForOnboarding } from "@/lib/onboarding";

describe("needsOnboarding — wizard redirect guard", () => {
  it("is true for a CLIENT_USER explicitly marked incomplete", () => {
    expect(needsOnboarding({ role: "CLIENT_USER", hasCompletedOnboarding: false })).toBe(true);
  });

  it("is false once a CLIENT_USER has finished the wizard", () => {
    expect(needsOnboarding({ role: "CLIENT_USER", hasCompletedOnboarding: true })).toBe(false);
  });

  it("is false for pre-existing CLIENT_USER accounts that predate this field (absent, not false)", () => {
    expect(needsOnboarding({ role: "CLIENT_USER" })).toBe(false);
  });

  it("never applies to staff, even if the field were somehow set", () => {
    expect(needsOnboarding({ role: "KAROS_ADMIN", hasCompletedOnboarding: false })).toBe(false);
    expect(needsOnboarding({ role: "KAROS_EMPLOYEE", hasCompletedOnboarding: false })).toBe(false);
  });
});

describe("shouldBlockForOnboarding — the actual (app) layout gate", () => {
  const unonboarded = { role: "CLIENT_USER" as const, hasCompletedOnboarding: false };

  it("blocks a real (non-impersonated) unonboarded client session", () => {
    expect(shouldBlockForOnboarding({ isImpersonating: false, user: unonboarded })).toBe(true);
  });

  it("never blocks staff viewing as an unonboarded client — no impersonation lockout", () => {
    expect(shouldBlockForOnboarding({ isImpersonating: true, user: unonboarded })).toBe(false);
  });

  it("doesn't block an already-onboarded session either way", () => {
    const onboarded = { role: "CLIENT_USER" as const, hasCompletedOnboarding: true };
    expect(shouldBlockForOnboarding({ isImpersonating: false, user: onboarded })).toBe(false);
    expect(shouldBlockForOnboarding({ isImpersonating: true, user: onboarded })).toBe(false);
  });
});
