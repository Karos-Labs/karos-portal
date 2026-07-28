import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  BRANDING_TOOL_REFUSAL,
  brandingToolRefusal,
  copilotToolsFor,
  isStaffCopilotActor,
  STAFF_ONLY_COPILOT_TOOLS,
} from "@/lib/copilot-tool-access";
import type { AppUser } from "@/lib/types";

/**
 * `update_branding_guidelines` rewrites the client's `branding-guidelines`
 * context doc, which lives at the INTERNAL tier — the analyst-grade copy
 * types.ts restricts to admin/employee and every agent prompt reads as ground
 * truth. It was registered on the copilot chat route with no role check
 * anywhere, and the route is reached by BOTH docks: the client shell mounts
 * CopilotDock for a CLIENT_USER, the staff shell mounts StaffCopilotDock.
 *
 * So a client session could write internal-tier content by asking the chatbot.
 * These tests pin the two fences that now stop it.
 */

const src = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
const route = src("app/api/clients/[id]/chat/route.ts");

const actor = (role: AppUser["role"], impersonatedBy?: string) =>
  ({ role, ...(impersonatedBy ? { impersonatedBy } : {}) }) as AppUser;

/** The registry the route hands to streamText, in the same shape. */
const ALL_TOOLS = {
  update_branding_guidelines: "branding",
  send_support_email: "support",
  fetch_gmail_context: "gmail",
  create_tasks: "tasks",
};

describe("copilot tool registry — staff-only writes", () => {
  it("withholds the branding tool from a real client session", () => {
    const tools = copilotToolsFor(actor("CLIENT_USER"), ALL_TOOLS);
    expect(tools).not.toHaveProperty("update_branding_guidelines");
  });

  it("withholds it from an admin impersonating a client", () => {
    // "View as Client" arrives as a CLIENT_USER carrying impersonatedBy
    // (auth.ts). Impersonation shows what the client sees; it is not a staff
    // capability escalator — same line isBillableClientActor draws for credits.
    const tools = copilotToolsFor(actor("CLIENT_USER", "admin-uid"), ALL_TOOLS);
    expect(tools).not.toHaveProperty("update_branding_guidelines");
    expect(isStaffCopilotActor(actor("CLIENT_USER", "admin-uid"))).toBe(false);
  });

  it("keeps it for staff sessions", () => {
    for (const role of ["KAROS_ADMIN", "KAROS_EMPLOYEE"] as const) {
      expect(copilotToolsFor(actor(role), ALL_TOOLS)).toHaveProperty(
        "update_branding_guidelines",
      );
    }
  });

  it("leaves every client-safe tool in place", () => {
    const tools = copilotToolsFor(actor("CLIENT_USER"), ALL_TOOLS);
    expect(Object.keys(tools).sort()).toEqual([
      "create_tasks",
      "fetch_gmail_context",
      "send_support_email",
    ]);
  });

  it("does not mutate the registry it was handed", () => {
    const all = { ...ALL_TOOLS };
    copilotToolsFor(actor("CLIENT_USER"), all);
    expect(all).toHaveProperty("update_branding_guidelines");
  });
});

describe("copilot branding tool — execute-level refusal", () => {
  it("refuses a client actor and names the surface they can use", () => {
    expect(brandingToolRefusal(actor("CLIENT_USER"))).toBe(BRANDING_TOOL_REFUSAL);
    expect(brandingToolRefusal(actor("CLIENT_USER", "admin-uid"))).toBe(
      BRANDING_TOOL_REFUSAL,
    );
    // Actionable, not a dead end: the client's own brand panel still works.
    expect(BRANDING_TOOL_REFUSAL).toMatch(/brand panel/i);
  });

  it("lets staff through", () => {
    expect(brandingToolRefusal(actor("KAROS_ADMIN"))).toBeNull();
    expect(brandingToolRefusal(actor("KAROS_EMPLOYEE"))).toBeNull();
  });
});

/**
 * Source-text assertions, same reason as shell-chrome.test.ts: the route is a
 * server module whose import graph reaches the Admin SDK, so it cannot be
 * imported into a node test run. What they pin is that the route actually
 * WIRES the fences above — the unit tests alone would still pass if someone
 * handed streamText the raw record.
 */
describe("chat route wiring", () => {
  it("passes its tool registry through the role filter", () => {
    expect(route).toMatch(/tools:\s*copilotToolsFor\(user,\s*\{/);
  });

  it("guards the branding tool's execute before it writes", () => {
    const execute = /const updateBrandingTool = tool\(\{[\s\S]*?\n  \}\);/.exec(route)?.[0] ?? "";
    expect(execute).not.toBe("");
    const refusalAt = execute.indexOf("brandingToolRefusal");
    const writeAt = execute.indexOf("updateClient(");
    expect(refusalAt).toBeGreaterThan(-1);
    // The refusal has to come first — a guard after the write is not a guard.
    expect(refusalAt).toBeLessThan(writeAt);
  });

  it("stops swallowing the context-doc sync failure", () => {
    // `catch {}` let the copilot report a clean success while the copy the
    // agents read stayed a version behind.
    expect(route).not.toMatch(/\}\s*catch\s*\{\s*\n\s*\/\/ Non-fatal\s*\n\s*\}/);
    expect(route).toMatch(/Branding context doc sync failed/);
  });

  it("tells a client session's prompt it has no branding tool", () => {
    expect(route).toMatch(/canUpdateBranding:\s*isStaffCopilotActor\(user\)/);
  });

  it("keeps the staff-only list and the tool name in step", () => {
    for (const name of STAFF_ONLY_COPILOT_TOOLS) {
      expect(route).toContain(`${name}: updateBrandingTool`);
    }
  });
});
