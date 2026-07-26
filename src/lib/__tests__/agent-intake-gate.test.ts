import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
  isLinkedInAgentIdentity,
  isXAgentIdentity,
} from "@/lib/custom-agent-launch";

/**
 * The X (e13) and LinkedIn (e10) agents run ON stored intake, so both submit
 * cores hard-gate a run that has none. Two things can silently break:
 *
 *  1. The refusal message must START with the exported prefix — the run dialog
 *     detects it with `startsWith` to offer a way into the agent data. A copy
 *     edit that puts anything before the prefix kills that affordance.
 *  2. The interactive core (lib/jobs/submit-custom.ts) and the scheduled/cron
 *     core (lib/agent-service/run-custom-agent.ts) must emit the SAME message,
 *     or the two paths drift.
 *
 * The messages are template literals inside Firestore-backed functions, so this
 * reads the sources rather than calling them.
 */
const CORES = ["src/lib/jobs/submit-custom.ts", "src/lib/agent-service/run-custom-agent.ts"];

function gateMessages(file: string): { x: string; linkedin: string } {
  const src = readFileSync(join(process.cwd(), file), "utf8");
  const found = [...src.matchAll(/error: `\$\{(X|LINKEDIN)_SETUP_REQUIRED_PREFIX\}([^`]*)`/g)];
  const x = found.find((m) => m[1] === "X");
  const linkedin = found.find((m) => m[1] === "LINKEDIN");
  if (!x || !linkedin) throw new Error(`Could not locate both setup-gate messages in ${file}`);
  return { x: x[2], linkedin: linkedin[2] };
}

describe("agent data setup gate", () => {
  it("keeps both submit cores on identical refusal copy", () => {
    const [interactive, scheduled] = CORES.map(gateMessages);
    expect(scheduled.x).toBe(interactive.x);
    expect(scheduled.linkedin).toBe(interactive.linkedin);
  });

  it("interpolates the prefix as the literal opening of each message", () => {
    for (const file of CORES) {
      const { x, linkedin } = gateMessages(file);
      // The prefix is the whole start of the string, so the rendered message
      // begins with it and the dialog's startsWith check holds.
      expect(`${X_SETUP_REQUIRED_PREFIX}${x}`.startsWith(X_SETUP_REQUIRED_PREFIX)).toBe(true);
      expect(
        `${LINKEDIN_SETUP_REQUIRED_PREFIX}${linkedin}`.startsWith(LINKEDIN_SETUP_REQUIRED_PREFIX),
      ).toBe(true);
      expect(x.endsWith("Nothing has run.")).toBe(true);
      expect(linkedin.endsWith("Nothing has run.")).toBe(true);
    }
  });

  it("keeps the X and LinkedIn refusals distinguishable", () => {
    const { x, linkedin } = gateMessages(CORES[0]);
    expect(x).not.toBe(linkedin);
    expect(x).toContain("fill in the company page");
    expect(linkedin).toContain("save the company page form");
  });

  it("names where the agent data lives", () => {
    // The data lives in the agent, so the copy names that destination. It also
    // surfaces inside the run dialog, where telling the reader to open the
    // dialog would be circular — hence no "Agent-specific documents" sidebar
    // section (deleted) and no separate data page to send anyone to.
    for (const file of CORES) {
      const { x, linkedin } = gateMessages(file);
      for (const message of [x, linkedin]) {
        expect(message).toContain("The agent data sits with the agent on the AI Agents page.");
        expect(message).not.toMatch(/Agent-specific documents/i);
        expect(message).not.toMatch(/data page/i);
      }
    }
  });

  it("gates both agents on the company page, never on a bare seat", () => {
    // We run these agents for a business, so the company page is the floor and
    // seats are additive. Seats are SHARED across agents (one person, one seat),
    // so a seat created for LinkedIn says nothing about X — gating on seats let
    // a LinkedIn-first client run X with no X company page at all. Both
    // predicates read the seatId-null intake doc; the derived `ready` flag on
    // the agents page mirrors it, and a drift here silently un-gates a run.
    const x = readFileSync(join(process.cwd(), "src/lib/agent-service/x-agent-context.ts"), "utf8");
    const gate = x.match(/export async function hasXAgentIntake[\s\S]*?\n}/)?.[0];
    expect(gate).toBeDefined();
    expect(gate).toContain('getAgentIntake(clientId, "x", null)');
    expect(gate).not.toMatch(/listClientSeats|seats\.length/);
  });

  it("gates exactly the two intake-driven agent identities", () => {
    expect(isXAgentIdentity("karos-x-agent")).toBe(true);
    expect(isLinkedInAgentIdentity("karos-linkedin-agent")).toBe(true);
    expect(isLinkedInAgentIdentity("karos-linkedin-company-karoslabs")).toBe(true);
    // A lookalike import is not intake-driven and must never hit the gate.
    expect(isXAgentIdentity("acme-x-ghostwriter")).toBe(false);
    expect(isLinkedInAgentIdentity("acme-linkedin-ghostwriter")).toBe(false);
  });
});
