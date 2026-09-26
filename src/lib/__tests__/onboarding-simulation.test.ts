import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

/**
 * The admin onboarding simulation renders the REAL onboarding wizard against
 * the admin's own session. Anything that writes would write a real record:
 * the draft and profile saves land on the admin's user document, the
 * uploaders on the admin's profile, the channel cards on a real client, and
 * Finish flips a client's onboarding and starts paid AI pipelines.
 *
 * So, in the wizard: every call of a writing action sits behind a
 * `simulation` guard, the scan swaps to the read-only admin action, and every
 * self-writing widget sits inside SimulationInert.
 */
const root = path.resolve(__dirname, "../../..");
const wizard = readFileSync(path.join(root, "src/components/onboarding-chat/onboarding-chat-wizard.tsx"), "utf8");

/** The source of a top-level or nested `function name(...) {...}` in the file, by brace matching. */
function fn(src: string, name: string): string {
  const start = src.search(new RegExp(`function ${name}\\(`));
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  let i = src.indexOf("{", src.indexOf(")", start));
  // Skip a destructured-parameter brace: the body starts after the `) {` that closes the signature.
  const sig = src.indexOf(") {", start);
  if (sig > 0) i = sig + 2;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

describe("onboarding simulation writes nothing", () => {
  it("Finish returns on simulation before completeOnboardingAction", () => {
    const body = fn(wizard, "finish");
    const guard = body.search(/if \(simulation\) \{[\s\S]*?return;/);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(body.indexOf("completeOnboardingAction("));
  });

  it("the draft save returns on simulation before saving", () => {
    const at = wizard.indexOf("saveOnboardingChatDraftAction(draft)");
    expect(at).toBeGreaterThan(0);
    const guard = wizard.lastIndexOf("if (simulation) return;", at);
    expect(guard, "no simulation guard before the draft save").toBeGreaterThan(0);
    expect(at - guard, "the guard belongs to a different block").toBeLessThan(200);
  });

  it("the LinkedIn connection returns on simulation before creating a seat", () => {
    const body = fn(wizard, "connectLinkedIn");
    const guard = body.indexOf("if (simulated) return;");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(body.indexOf("saveOnboardingProfileAction("));
    expect(guard).toBeLessThan(body.indexOf("ensureOwnEmployeeSeatAction("));
  });

  it("logo upload is switched off in a simulation (it would replace a real client's logo)", () => {
    expect(wizard).toMatch(/const uploadLogo = simulation\s*\?\s*undefined/);
  });

  it("the scan is the admin action in a simulation", () => {
    expect(wizard).toMatch(/simulation \? simulateOnboardingDiscoveryAction : discoverOnboardingProfileAction/);
  });

  it("makes the self-writing widgets inert", () => {
    for (const tag of ["<AvatarUploader", "<ResumeUploader", "<IntegrationsTab"]) {
      const at = wizard.indexOf(tag);
      expect(at, tag).toBeGreaterThan(0);
      const opened = wizard.lastIndexOf("<SimulationInert active=", at);
      const closed = wizard.lastIndexOf("</SimulationInert>", at);
      expect(opened, `${tag} is not inside SimulationInert`).toBeGreaterThan(closed);
    }
  });

  it("the admin scan action is admin-gated before it scans", () => {
    const action = readFileSync(path.join(root, "src/lib/actions/onboarding-simulation-actions.ts"), "utf8");
    expect(action.indexOf("await requireAdmin()")).toBeGreaterThan(0);
    expect(action.indexOf("await requireAdmin()")).toBeLessThan(action.indexOf("discoverOnboardingProfile({"));
  });
});
