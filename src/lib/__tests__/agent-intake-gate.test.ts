import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  REDDIT_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
  agentKeyMatchesClientSlug,
  clientSafeRefusal,
  isLinkedInAgentIdentity,
  isRedditAgentIdentity,
  isXAgentIdentity,
  perClientAgentSlug,
} from "@/lib/custom-agent-launch";

/**
 * The X (e13), LinkedIn (e10) and Reddit (e15) agents run ON stored intake, so
 * both submit cores hard-gate a run that has none. Two things can silently
 * break:
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
const KINDS = ["X", "LINKEDIN", "REDDIT"] as const;
type Kind = (typeof KINDS)[number];

/**
 * The RAW source template literal of each setup refusal — matched on "contains
 * the prefix", not on "opens with the prefix".
 *
 * That distinction is the whole point. Matching only literals that already open
 * with the interpolation means a copy edit which prepends text drops out of the
 * match set entirely, and every check downstream then runs on messages that
 * pass by construction. Matched loosely, the same edit shows up as a literal
 * that fails the opening assertion.
 */
function gateLiterals(file: string): Record<Kind, string> {
  const src = readFileSync(join(process.cwd(), file), "utf8");
  const literals = [...src.matchAll(/error: `([^`]*)`/g)].map((m) => m[1]);
  const out = {} as Record<Kind, string>;
  for (const kind of KINDS) {
    const hits = literals.filter((l) => l.includes(`\${${kind}_SETUP_REQUIRED_PREFIX}`));
    if (hits.length !== 1) {
      throw new Error(
        `Expected exactly one ${kind} setup-gate message in ${file}, found ${hits.length}`,
      );
    }
    out[kind] = hits[0];
  }
  return out;
}

/** The literals with their opening prefix interpolation removed. */
function gateMessages(file: string): { x: string; linkedin: string; reddit: string } {
  const literals = gateLiterals(file);
  const strip = (kind: Kind) =>
    literals[kind].replace(new RegExp(`^\\$\\{${kind}_SETUP_REQUIRED_PREFIX\\}`), "");
  return { x: strip("X"), linkedin: strip("LINKEDIN"), reddit: strip("REDDIT") };
}

describe("agent data setup gate", () => {
  it("keeps both submit cores on identical refusal copy", () => {
    const [interactive, scheduled] = CORES.map(gateMessages);
    expect(scheduled.x).toBe(interactive.x);
    expect(scheduled.linkedin).toBe(interactive.linkedin);
    expect(scheduled.reddit).toBe(interactive.reddit);
  });

  it("opens each message with the prefix and nothing before it", () => {
    for (const file of CORES) {
      const literals = gateLiterals(file);
      // Asserted on the RAW source literal. `${PREFIX}${body}`.startsWith(PREFIX)
      // is true of every body ever written, so the old form of this check could
      // not fail; what has to be pinned is that the interpolation is the first
      // thing inside the backtick.
      for (const kind of KINDS) {
        expect(
          literals[kind].startsWith(`\${${kind}_SETUP_REQUIRED_PREFIX}`),
          `${file}: the ${kind} refusal puts text before its prefix`,
        ).toBe(true);
      }
      const { x, linkedin, reddit } = gateMessages(file);
      expect(x.endsWith("Nothing has run.")).toBe(true);
      expect(linkedin.endsWith("Nothing has run.")).toBe(true);
      expect(reddit.endsWith("Nothing has run.")).toBe(true);

      // And the consumer agrees: clientSafeRefusal passes a setup refusal
      // through verbatim and collapses anything else to one generic sentence,
      // so a prepended word would reach a client as "could not start" with the
      // instructions stripped off. This is the same startsWith the run dialog
      // uses to offer the way into the agent data.
      for (const rendered of [
        `${X_SETUP_REQUIRED_PREFIX}${x}`,
        `${LINKEDIN_SETUP_REQUIRED_PREFIX}${linkedin}`,
        `${REDDIT_SETUP_REQUIRED_PREFIX}${reddit}`,
      ]) {
        expect(clientSafeRefusal(rendered)).toBe(rendered);
      }
    }
  });

  it("keeps the three refusals told apart by their prefixes", () => {
    const { x, linkedin, reddit } = gateMessages(CORES[0]);
    // Ruled copy: the three BODIES are deliberately unified. X and LinkedIn
    // both draft from a company page form and say so in the same words, and
    // inventing a wording difference to satisfy a test would make one of them
    // describe itself wrongly. All the distinguishing work is therefore done by
    // the PREFIX — so that is what gets pinned here.
    //
    // Comparing the three RENDERED strings, as this test used to, proves
    // nothing: the prefixes are distinct constants, so re-adding them makes any
    // three bodies — including three identical ones — come out as three
    // distinct messages. The set-size check belongs on the prefixes themselves.
    const prefixes = [
      X_SETUP_REQUIRED_PREFIX,
      LINKEDIN_SETUP_REQUIRED_PREFIX,
      REDDIT_SETUP_REQUIRED_PREFIX,
    ];
    expect(new Set(prefixes).size).toBe(3);
    // Each names its own agent kind, so a reader can tell who is asking.
    expect(X_SETUP_REQUIRED_PREFIX).toContain("X agent");
    expect(LINKEDIN_SETUP_REQUIRED_PREFIX).toContain("LinkedIn agent");
    expect(REDDIT_SETUP_REQUIRED_PREFIX).toContain("Reddit agent");
    // And no prefix may be a prefix of another: clientSafeRefusal and the run
    // dialog both dispatch on startsWith, so an overlapping pair would route
    // one agent's refusal at the other agent's data.
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a !== b) expect(a.startsWith(b)).toBe(false);
      }
    }
    // The bodies still have to name the FORM, which is where the two
    // company-page agents and Reddit legitimately differ.
    expect(x).toContain("the company page form");
    expect(linkedin).toContain("the company page form");
    // Reddit's company-level form is the account form, not a company page.
    expect(reddit).toContain("the account form");
  });

  it("names where the agent data lives", () => {
    // The data lives in the agent, so the copy names that destination — and
    // names the CLICK that reaches it, because a reader who is told where a
    // thing lives still has to find it. It also surfaces inside the run dialog,
    // where telling the reader to open the dialog would be circular — hence no
    // "Agent-specific documents" sidebar section (deleted) and no separate data
    // page to send anyone to.
    for (const file of CORES) {
      const { x, linkedin, reddit } = gateMessages(file);
      for (const message of [x, linkedin, reddit]) {
        expect(message).toContain("Open this agent on your AI agents page");
        expect(message).toContain('follow "Set it up" under "What it knows about you"');
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

    // The LinkedIn company floor holds for the company-page INSTANCES, which
    // are the keys with a company form of their own to fill. The Path-B master
    // (karos-linkedin-agent) has none, so it gates on any LinkedIn intake
    // instead — company page or seat. Collapsing the two locked the master out
    // of a workspace that is fully set up on the seat side, which is why the
    // gate keeps its agent-key argument.
    const li = readFileSync(
      join(process.cwd(), "src/lib/agent-service/linkedin-agent-context.ts"),
      "utf8",
    );
    const liGate = li.match(/export async function hasLinkedInAgentIntake[\s\S]*?\n}/)?.[0];
    expect(liGate).toBeDefined();
    expect(liGate).toContain("agentKey");
    // The default branch — every company-page instance — is still the
    // seatId-null company doc, and reads no seat list.
    expect(liGate).toContain('getAgentIntake(clientId, "linkedin", null)');
    expect(liGate).not.toMatch(/listClientSeats|seats\.length/);
    // The master's branch is keyed on the master's own identity, so no instance
    // can reach the wider check.
    expect(liGate).toContain('agentKey === "karos-linkedin-agent"');
    // ...and that branch takes the WIDER read — any LinkedIn intake, company
    // page or seat. Without this, a branch that just returned false would still
    // satisfy every assertion above while locking the master out again.
    expect(liGate).toContain('listAgentIntake(clientId, "linkedin")');
    // Having the key here is only half of it: the gate is keyed and its CALLERS
    // must pass the key, or the card and the cores answer differently for a
    // seat-only workspace. agent-launch-ui.test.ts pins the call sites.

    // Reddit's floor is its account form. Seats are shared across agents and
    // Reddit does not use them at all, so reading one here would accept a run
    // set up for another platform entirely.
    const reddit = readFileSync(
      join(process.cwd(), "src/lib/agent-service/reddit-agent-context.ts"),
      "utf8",
    );
    const redditGate = reddit.match(/export async function hasRedditAgentIntake[\s\S]*?\n}/)?.[0];
    expect(redditGate).toBeDefined();
    expect(redditGate).toContain('getAgentIntake(clientId, "reddit", null)');
    expect(redditGate).not.toMatch(/listAgentIntake|listClientSeats|seats\.length/);
  });

  it("gates exactly the three intake-driven agent identities", () => {
    expect(isXAgentIdentity("karos-x-agent")).toBe(true);
    expect(isLinkedInAgentIdentity("karos-linkedin-agent")).toBe(true);
    expect(isLinkedInAgentIdentity("karos-linkedin-company-karoslabs")).toBe(true);
    expect(isRedditAgentIdentity("karos-reddit-agent")).toBe(true);
    // A lookalike import is not intake-driven and must never hit the gate.
    expect(isXAgentIdentity("acme-x-ghostwriter")).toBe(false);
    expect(isLinkedInAgentIdentity("acme-linkedin-ghostwriter")).toBe(false);
    expect(isRedditAgentIdentity("acme-reddit-ghostwriter")).toBe(false);
    // The emitted per-client lab sub-skills are not the portal agent either.
    expect(isRedditAgentIdentity("karos-reddit-thorough-value-karoslabs")).toBe(false);
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

  it("refuses the BIND, not only the launch", () => {
    // Ruling 1. Binding a per-client instance to another client creates an
    // umbrella that reads as a set-up agent and can never produce: every launch
    // and every scheduled fire is refused by the cores before a job row exists.
    // Refusing at bind time is what keeps that umbrella off the disk in the
    // first place; the launch gate's rung covers the ones already there.
    const src = readFileSync(
      join(process.cwd(), "src/lib/actions/client-agent-actions.ts"),
      "utf8",
    );
    const start = src.indexOf("export async function bindClientAgentAction");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nexport async function ", start + 1);
    // Without this, a rename of the NEXT export silently widens the slice to
    // the rest of the file and the assertions below stop being about
    // bindClientAgentAction at all.
    expect(end, "bindClientAgentAction is no longer followed by another export").toBeGreaterThan(
      start,
    );
    const body = src.slice(start, end);
    const guardAt = body.indexOf("agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug)");
    expect(guardAt, "bindClientAgentAction does not check the binding").toBeGreaterThan(-1);
    // Ahead of the write, so a refused bind leaves nothing behind.
    expect(guardAt).toBeLessThan(body.indexOf("await upsertClientAgent("));
    expect(body).toContain("perClientAgentSlug(agent.key)");

    // The launch gate carries the same rung, above the intake rung: filling in
    // a form cannot unblock a pair refused on identity.
    const gate = readFileSync(join(process.cwd(), "src/lib/client-agents.ts"), "utf8");
    const bindingAt = gate.indexOf('code: "wrong_client_binding"');
    const intakeAt = gate.indexOf('code: "intake_required"');
    expect(bindingAt).toBeGreaterThan(-1);
    expect(bindingAt).toBeLessThan(intakeAt);
  });

  it("refuses to write a schedule that every fire would refuse", () => {
    // A schedule created past a run gate fires into nothing: the submit core
    // refuses before it writes a job row, so there is no failed job and no
    // charge — only a card that reads as live. Every path that writes an ENABLED
    // row therefore clears the same gates first, from one shared predicate.
    const gate = readFileSync(join(process.cwd(), "src/lib/jobs/schedule-gate.ts"), "utf8");
    expect(gate).toContain("agentKeyMatchesClientSlug(agent.key, client.agentsRepoSlug)");
    expect(gate).toContain("hasXAgentIntake(client.id)");
    // Keyed, so the Path-B master is judged by the rule that applies to it.
    expect(gate).toContain("hasLinkedInAgentIntake(client.id, agent.key)");
    // Reddit runs daily, so most of its runs arrive through a schedule rather
    // than the run dialog — an ungated Reddit schedule would be the quietest
    // failure of the three.
    expect(gate).toContain("hasRedditAgentIntake(client.id)");

    // Every action that can put a schedule live, in both collections: staff
    // create, the client's always-on card, resuming a paused row, and the
    // admin-only legacy card (create, switch back on).
    //
    // The legacy card has no edit path: `updateScheduledRunAction` existed and
    // was correctly gated, but scheduled-runs.tsx only ever called create,
    // toggle and delete, so it was dead and was removed (QA #164). This list is
    // the ENABLING actions that exist, not a wish-list — an entry for a
    // function that is gone fails on the assertion below, which is what keeps
    // it honest in both directions.
    const callers: Record<string, string[]> = {
      "src/lib/actions/planned-run-actions.ts": [
        "createPlannedRunAction",
        "configureClientAgentScheduleAction",
        "setPlannedRunStatusAction",
      ],
      "src/lib/actions/scheduled-run-actions.ts": [
        "createScheduledRunAction",
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
    //
    // Both indices are asserted PRESENT before they are ordered. A bare
    // `indexOf(a) < indexOf(b)` passes whenever `a` is missing, because the -1
    // it returns is less than every real position — so deleting the enabling
    // branch outright, which is exactly the regression this pins, would have
    // read as "correctly ordered".
    const orderedBefore = (body: string, guard: string, gate: string) => {
      const guardAt = body.indexOf(guard);
      const gateAt = body.indexOf(gate);
      expect(guardAt, `the enabling branch \`${guard}\` is gone`).toBeGreaterThan(-1);
      expect(gateAt, `the schedule gate is gone from this action`).toBeGreaterThan(-1);
      expect(guardAt, `\`${guard}\` no longer fences the gate`).toBeLessThan(gateAt);
    };
    const planned = readFileSync(
      join(process.cwd(), "src/lib/actions/planned-run-actions.ts"),
      "utf8",
    );
    const resume = planned.slice(planned.indexOf("export async function setPlannedRunStatusAction"));
    orderedBefore(resume, 'if (status === "active") {', "await unfireableScheduleReason(");
    const legacy = readFileSync(
      join(process.cwd(), "src/lib/actions/scheduled-run-actions.ts"),
      "utf8",
    );
    const toggle = legacy.slice(legacy.indexOf("export async function toggleScheduledRunAction"));
    orderedBefore(toggle, "if (enabled) {", "await unfireableScheduleReason(");
  });
});
