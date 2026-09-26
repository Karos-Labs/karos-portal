import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

/**
 * The admin onboarding simulation renders the REAL wizard against the admin's
 * own session. Any server action it reaches writes a real record — the profile
 * save lands on the admin's user document, Finish flips a client's onboarding
 * and starts paid AI pipelines. So every wizard handler that calls one must
 * return on `simulation` before the call, and every widget that writes on its
 * own must sit inside SimulationInert.
 */
const root = path.resolve(__dirname, "../../..");
const wizard = readFileSync(path.join(root, "src/components/onboarding-wizard.tsx"), "utf8");

const ACTIONS = ["saveOnboardingProfileAction", "ensureOwnEmployeeSeatAction", "completeOnboardingAction"];

function handlerBodies(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /\n  function (\w+)\([^)]*\) \{\n([\s\S]*?)\n  \}\n/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ name: m[1], body: m[2] });
  return out;
}

describe("onboarding wizard simulation", () => {
  const handlers = handlerBodies(wizard);

  it("finds the handlers it guards (the instrument can see them)", () => {
    for (const action of ACTIONS) {
      expect(handlers.some((h) => h.body.includes(`${action}(`)), action).toBe(true);
    }
  });

  for (const action of ACTIONS) {
    it(`returns on simulation before ${action}`, () => {
      for (const h of handlers.filter((x) => x.body.includes(`${action}(`))) {
        const guard = h.body.search(/if \(simulation\) \{[\s\S]*?return;/);
        expect(guard, `${h.name} has no simulation guard`).toBeGreaterThanOrEqual(0);
        expect(guard, `${h.name} calls ${action} before its guard`).toBeLessThan(h.body.indexOf(`${action}(`));
      }
    });
  }

  it("makes the self-writing widgets inert", () => {
    for (const tag of ["<AvatarUploader", "<ResumeUploader", "<OnboardingSocialsStep"]) {
      const at = wizard.indexOf(tag);
      expect(at, tag).toBeGreaterThan(0);
      const opened = wizard.lastIndexOf("<SimulationInert", at);
      const closed = wizard.lastIndexOf("</SimulationInert>", at);
      expect(opened, `${tag} is not inside SimulationInert`).toBeGreaterThan(closed);
    }
  });
});
