import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
  agentKeyMatchesClientSlug,
  isLinkedInAgentIdentity,
  isXAgentIdentity,
  perClientAgentSlug,
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

    // The LinkedIn floor holds for every e10 key, master included: a client
    // with a seat and no company page sees "Setup needed" on the page, so a
    // key-specific exemption would accept a run the page cannot reach.
    const li = readFileSync(
      join(process.cwd(), "src/lib/agent-service/linkedin-agent-context.ts"),
      "utf8",
    );
    const liGate = li.match(/export async function hasLinkedInAgentIntake[\s\S]*?\n}/)?.[0];
    expect(liGate).toBeDefined();
    expect(liGate).toContain('getAgentIntake(clientId, "linkedin", null)');
    expect(liGate).not.toMatch(/listAgentIntake|listClientSeats|seats\.length/);
    expect(liGate).not.toContain("karos-linkedin-agent");
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

/**
 * A per-client agent instance is imported once per client and named after that
 * client's lab folder (karos-linkedin-company-<agentsRepoSlug>), which is where
 * its entry skill is baked. Offering one to another client hands that client's
 * intake to a different company's playbook, so the binding is derived in one
 * place and enforced on both the list and the submit.
 */
describe("per-client agent instance binding", () => {
  const CLIENT_SLUGS = [
    "geektime",
    "hankypanky",
    "kindlyyours",
    "thepitchbydeel",
    "sitti",
    "karoslabs",
    "xodigital",
  ];
  const KAROS_LINKEDIN = "karos-linkedin-company-karoslabs";

  it("keeps Karos Labs' own LinkedIn instance on Karos Labs", () => {
    expect(perClientAgentSlug(KAROS_LINKEDIN)).toBe("karoslabs");
    expect(agentKeyMatchesClientSlug(KAROS_LINKEDIN, "karoslabs")).toBe(true);
    // A slug typed as a pasted repo path resolves to the same folder, so the
    // owning client never loses its own agent to an unnormalized field.
    expect(agentKeyMatchesClientSlug(KAROS_LINKEDIN, "clients/karoslabs/outputs")).toBe(true);
    expect(agentKeyMatchesClientSlug(KAROS_LINKEDIN, " Karoslabs ")).toBe(true);
  });

  it("offers that instance to no other client", () => {
    for (const slug of CLIENT_SLUGS.filter((s) => s !== "karoslabs")) {
      expect(agentKeyMatchesClientSlug(KAROS_LINKEDIN, slug)).toBe(false);
    }
    // A client with no lab folder cannot be matched to one, so it earns no
    // instance — the safe direction, since a wrong match drafts another company.
    for (const slug of ["", null, undefined]) {
      expect(agentKeyMatchesClientSlug(KAROS_LINKEDIN, slug)).toBe(false);
    }
    expect(perClientAgentSlug("karos-linkedin-company-xodigital")).toBe("xodigital");
    // An instance naming a folder no client in the portal claims is offered to
    // none of them, rather than to all of them.
    for (const slug of CLIENT_SLUGS) {
      expect(agentKeyMatchesClientSlug("karos-linkedin-company-acme", slug)).toBe(false);
    }
  });

  it("leaves agents bound to no client runnable for everyone", () => {
    const unbound = [
      "karos-x-agent",
      "karos-linkedin-agent",
      "karos-reddit-agent",
      "karos-tiktok-agent",
      "karos-instagram-agent",
      "branded-shorts",
      "landing-builder",
      // A bare prefix names no client, so it is not treated as an instance.
      "karos-linkedin-company-",
    ];
    for (const key of unbound) {
      expect(perClientAgentSlug(key)).toBeNull();
      for (const slug of [...CLIENT_SLUGS, "", undefined]) {
        expect(agentKeyMatchesClientSlug(key, slug)).toBe(true);
      }
    }
  });

  it("refuses a mismatched pair in BOTH submit cores, before any job exists", () => {
    // The page filter alone leaves a stale tab, a saved link, an MCP call and a
    // stored schedule row able to submit the pair, so both cores check it too —
    // and ahead of createJob, so a refusal leaves no queued row and no charge.
    // /api/scheduler reaches run-custom-agent.ts with an (agentId, clientId)
    // pair read off a scheduledRuns row that may predate the binding, which is
    // exactly the case the page filter cannot reach.
    for (const file of CORES) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      const guardAt = src.indexOf("agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug)");
      expect(guardAt, `${file} does not check the binding`).toBeGreaterThan(-1);
      expect(guardAt, `${file} checks the binding too late`).toBeLessThan(
        src.indexOf("await createJob("),
      );
      // The refusal names both sides of the mismatch.
      expect(src).toContain("perClientAgentSlug(agent.key)");
      expect(src).toContain("client.name");
    }
  });

  it("refuses to write a schedule that every fire would refuse", () => {
    // A schedule created past a run gate fires into nothing: the submit core
    // refuses before it writes a job row, so there is no failed job and no
    // charge — only a card that reads as live. Every path that writes an ENABLED
    // row therefore clears the same gates first, from one shared predicate.
    const gate = readFileSync(join(process.cwd(), "src/lib/jobs/schedule-gate.ts"), "utf8");
    expect(gate).toContain("agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug)");
    expect(gate).toContain("hasXAgentIntake(client.id)");
    expect(gate).toContain("hasLinkedInAgentIntake(client.id)");

    // Every action that can put a schedule live, in both collections: staff
    // create, the client's always-on card, resuming a paused row, and the
    // admin-only legacy card (create, edit, switch back on).
    const callers: Record<string, string[]> = {
      "src/lib/actions/planned-run-actions.ts": [
        "createPlannedRunAction",
        "configureClientAgentScheduleAction",
        "setPlannedRunStatusAction",
      ],
      "src/lib/actions/scheduled-run-actions.ts": [
        "createScheduledRunAction",
        "updateScheduledRunAction",
        "toggleScheduledRunAction",
      ],
    };
    for (const [file, fns] of Object.entries(callers)) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      for (const fn of fns) {
        const start = src.indexOf(`export async function ${fn}`);
        expect(start, `${fn} is gone from ${file}`).toBeGreaterThan(-1);
        const nextFn = src.indexOf("\nexport async function ", start + 1);
        const body = src.slice(start, nextFn === -1 ? undefined : nextFn);
        expect(
          body.includes("await unfireableScheduleReason("),
          `${fn} does not clear the schedule gate`,
        ).toBe(true);
      }
    }
    // Turning a schedule OFF is never blocked — that is the row someone most
    // needs to be able to switch off. Both resume paths ask before enabling.
    const planned = readFileSync(
      join(process.cwd(), "src/lib/actions/planned-run-actions.ts"),
      "utf8",
    );
    const resume = planned.slice(planned.indexOf("export async function setPlannedRunStatusAction"));
    expect(resume.indexOf('if (status === "active") {')).toBeLessThan(
      resume.indexOf("await unfireableScheduleReason("),
    );
    const legacy = readFileSync(
      join(process.cwd(), "src/lib/actions/scheduled-run-actions.ts"),
      "utf8",
    );
    const toggle = legacy.slice(legacy.indexOf("export async function toggleScheduledRunAction"));
    expect(toggle.indexOf("if (enabled) {")).toBeLessThan(
      toggle.indexOf("await unfireableScheduleReason("),
    );
  });
});
