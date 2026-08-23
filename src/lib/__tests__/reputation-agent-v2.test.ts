import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPUTATION_ENVELOPE_KIND,
  buildReputationEnvelope,
  isReputationEnvelope,
  reputationEnvelopeHasContent,
  reputationStateContentType,
  reputationStateDateFor,
  reputationStateHasContent,
  reputationStateKindFor,
} from "@/lib/agent-service/reputation-state-capture";
import {
  REPUTATION_MANAGER_KEY,
  REPUTATION_RUNNER_KEY,
  REPUTATION_RUN_CREDITS,
  REPUTATION_SETUP_KEY,
  isReputationAgentIdentity,
  isSubAgent,
  isUnlistedAgent,
  launchProfileFor,
} from "@/lib/custom-agent-launch";

/**
 * Reputation v2's own guarantees. Pure: the envelope assembler, the state
 * matcher, the key predicates, the launch-profile routing. Server modules are
 * `server-only`, so anything that has to agree across the RSC boundary is
 * asserted through its source.
 */

const RUN = "clients/xodigital/outputs/reputation-agent-v2/2026-08-11-pulse-004";

describe("the reputation v2 keys", () => {
  it("names the RUNNER as the agent and the other two as its steps", () => {
    expect(isReputationAgentIdentity(REPUTATION_RUNNER_KEY)).toBe(true);
    for (const key of [REPUTATION_SETUP_KEY, REPUTATION_MANAGER_KEY]) {
      // NOT the agent: this predicate decides who gets the reputation intake and
      // the setup gate, and a setup run that gated on its own output could never
      // run at all.
      expect(isReputationAgentIdentity(key), key).toBe(false);
      expect(isSubAgent({ key, parentKey: REPUTATION_RUNNER_KEY }), key).toBe(true);
      expect(isUnlistedAgent({ key, parentKey: REPUTATION_RUNNER_KEY }), key).toBe(true);
    }
    expect(isUnlistedAgent({ key: REPUTATION_RUNNER_KEY })).toBe(false);
  });

  it("carries no -v2 suffix, matching the manifest rather than its siblings", () => {
    // The DIRECTORY is `reputation-agent-v2`; the KEYS are not. That asymmetry is
    // the manifest's, and a key invented to look like the newsletter's would
    // match nothing — the agent would never be gated, fed or hidden, which is
    // silent in every direction.
    for (const key of [REPUTATION_RUNNER_KEY, REPUTATION_SETUP_KEY, REPUTATION_MANAGER_KEY]) {
      expect(key.endsWith("-v2"), key).toBe(false);
      expect(key.startsWith("karos-reputation-"), key).toBe(true);
    }
  });

  it("prices a pulse as a DECISION, not a carried price", () => {
    // Unlike the newsletter's and the blog's tens, nothing preceded this — there
    // has never been a managed reputation task, so there is no bill to hold
    // steady. It is set to the generic custom-agent rate on purpose, which is
    // also why the rate card needs no row of its own: the existing
    // "Agent run · from" line already quotes that number.
    expect(REPUTATION_RUN_CREDITS).toBe(25);
    const credits = readFileSync(join(process.cwd(), "src/lib/credits.ts"), "utf8");
    expect(credits).toContain("export const REPUTATION_RUN_CREDITS = 25");
    expect(credits, "reputation is not a managed product and must not gain a row").not.toMatch(
      /^\s*reputation: \d+,/m,
    );
  });
});

describe("the launch profile, which the loose regex would otherwise hijack", () => {
  it("gives each v2 skill its own brief, not the legacy reputation one", () => {
    // `profiles` is first-match-wins and a loose /reputation|reviews|monitor/
    // entry has lived in that array since before v2. Its brief asks for the
    // brand, the surfaces, the market and the response rules — all of which v2
    // BUILDS at setup — and two of its fields are `required: true`, so it would
    // block every run until somebody typed answers this product does not want.
    const runner = launchProfileFor({ key: REPUTATION_RUNNER_KEY, name: "Reputation Agent" });
    expect(runner.eyebrow).toBe("Reputation pulse");
    expect(runner.fields.every((f) => !f.required)).toBe(true);
    expect(runner.fields.map((f) => f.key)).toEqual(["request"]);

    expect(launchProfileFor({ key: REPUTATION_SETUP_KEY, name: "Reputation Setup" }).eyebrow).toBe(
      "Reputation setup",
    );
    expect(
      launchProfileFor({ key: REPUTATION_MANAGER_KEY, name: "Reputation Manager" }).eyebrow,
    ).toBe("Reputation review");
  });

  it("leaves the legacy catalogue product on the old brief", () => {
    // `karos-reputation` is a different product and still needs the loose
    // profile. Removing it to make room would have been the easy wrong fix.
    const legacy = launchProfileFor({ key: "karos-reputation", name: "Brand Reputation Monitoring" });
    expect(legacy.eyebrow).toBe("Reputation brief");
    expect(legacy.fields.some((f) => f.required)).toBe(true);
  });
});

describe("which artifacts are durable state", () => {
  it("recognises all seven contract files", () => {
    const cases: Array<[string, string]> = [
      ["clients/xo/skills/reputation-agent-v2/01-facts.md", "facts"],
      ["clients/xo/skills/reputation-agent-v2/02-config.json", "config"],
      ["clients/xo/skills/reputation-agent-v2/03-autonomy.json", "autonomy"],
      ["clients/xo/skills/reputation-agent-v2/roster.json", "roster"],
      ["clients/xo/skills/reputation-agent-v2/response-voice.md", "response-voice"],
      ["clients/xo/skills/reputation-agent-v2/response-ledger.json", "response-ledger"],
      ["clients/xo/skills/reputation-agent-v2/crisis-ledger.jsonl", "crisis-ledger"],
    ];
    for (const [path, kind] of cases) {
      expect(reputationStateKindFor(path), path).toBe(kind);
    }
  });

  it("REFUSES the whole internal trail, which matters more here than elsewhere", () => {
    // THREE of the seven state files are number-prefixed, and the runner's own
    // trail is numbered too (01-run.md … 11-payload.json, with 03-envelope.json
    // among them). `03-envelope.json` is not `03-autonomy.json`, so a base-name
    // match is safe on today's names — but the two namespaces are one typo
    // apart, and refusing internal/ outright means a future run file called
    // `02-config.json` cannot overwrite the client's real config.
    for (const p of [
      `${RUN}/internal/inputs/roster.json`,
      `${RUN}/internal/03-envelope.json`,
      `${RUN}/internal/02-config.json`,
      `${RUN}/internal/11-payload.json`,
    ]) {
      expect(reputationStateKindFor(p), p).toBeNull();
    }
    expect(reputationStateKindFor("clients/xo/skills/reputation-agent-v2/roster.json")).toBe(
      "roster",
    );
  });

  it("types the .jsonl as ndjson, not as json", () => {
    // A stream of objects one per line. A parser told `application/json` fails
    // on the second line.
    expect(reputationStateContentType("a/crisis-ledger.jsonl")).toBe("application/x-ndjson");
    expect(reputationStateContentType("a/response-ledger.json")).toBe("application/json");
    expect(reputationStateContentType("a/response-voice.md")).toBe("text/markdown");
  });

  it("refuses an empty body, which is what makes whole-file replace safe", () => {
    // Both ledgers are append-only in the workspace and stored here as one blob,
    // so an empty delivery would REPLACE a full response ledger with nothing —
    // exactly the state that produces a duplicate public reply.
    expect(reputationStateHasContent("")).toBe(false);
    expect(reputationStateHasContent("   \n\t ")).toBe(false);
    expect(reputationStateHasContent('{"review_id":"r1"}')).toBe(true);
  });

  it("dates from the path when it has one", () => {
    const t = new Date("2026-08-12T00:02:00Z").getTime();
    expect(reputationStateDateFor(`${RUN}/x.json`, t)).toBe("2026-08-11");
    expect(reputationStateDateFor("clients/xo/skills/reputation-agent-v2/roster.json", t)).toBe(
      "2026-08-12",
    );
  });
});

describe("the deliverable envelope", () => {
  const files = [
    { path: `${RUN}/client/01-response-drafts/r-101.md`, text: "Thanks for letting us know." },
    { path: `${RUN}/client/01-response-drafts/r-102.md`, text: "Sorry about the wait." },
    { path: `${RUN}/client/02-flags/r-103.md`, text: "URGENT: alleges injury." },
    { path: `${RUN}/client/about.txt`, text: "One flagged review. Send to Dana." },
  ];

  it("sorts by FOLDER, keeping drafts and flags apart", () => {
    const env = buildReputationEnvelope(files);
    expect(env.kind).toBe(REPUTATION_ENVELOPE_KIND);
    expect(env.drafts?.map((d) => d.name)).toEqual(["r-101.md", "r-102.md"]);
    expect(env.flags?.map((f) => f.name)).toEqual(["r-103.md"]);
    expect(env.about).toContain("Dana");
    expect(env.pulseNumber).toBe("004");
  });

  it("counts a FLAGS-ONLY pulse as content", () => {
    // The case worth pinning: a pulse that found nothing safe to answer but did
    // find something urgent has zero drafts, and is the single most important
    // run this product can produce. Requiring a draft would drop it.
    const env = buildReputationEnvelope([files[2]]);
    expect(env.drafts).toBeUndefined();
    expect(env.flags).toHaveLength(1);
    expect(reputationEnvelopeHasContent(env)).toBe(true);
    // Nothing at all IS empty, and the caller must not store an asset for it.
    expect(reputationEnvelopeHasContent(buildReputationEnvelope([]))).toBe(false);
    expect(
      reputationEnvelopeHasContent(
        buildReputationEnvelope([{ path: `${RUN}/client/about.txt`, text: "  " }]),
      ),
    ).toBe(false);
  });

  it("ignores a file in neither folder rather than guessing", () => {
    const env = buildReputationEnvelope([
      ...files,
      { path: `${RUN}/client/03-notes/scratch.md`, text: "stray" },
    ]);
    expect(env.drafts).toHaveLength(2);
    expect(env.flags).toHaveLength(1);
    expect(JSON.stringify(env)).not.toContain("stray");
  });

  it("sniffs its own envelope and no sibling's", () => {
    expect(isReputationEnvelope(JSON.stringify(buildReputationEnvelope(files)))).toBe(true);
    expect(isReputationEnvelope('{"kind":"blog-post-v2","html":"x"}')).toBe(false);
    expect(isReputationEnvelope('{"kind":"newsletter-issue-v2"}')).toBe(false);
    expect(isReputationEnvelope("")).toBe(false);
  });
});

describe("the wiring that has to agree across modules", () => {
  const core = readFileSync(join(process.cwd(), "src/lib/jobs/submit-custom.ts"), "utf8");
  const context = readFileSync(
    join(process.cwd(), "src/lib/agent-service/reputation-agent-context.ts"),
    "utf8",
  );
  const actions = readFileSync(
    join(process.cwd(), "src/lib/actions/reputation-agent-actions.ts"),
    "utf8",
  );

  it("gates on the intake AND on setup having produced a roster", () => {
    expect(core).toContain("hasReputationAgentIntake(input.clientId)");
    expect(core).toContain("hasReputationV2Setup(input.clientId)");
    expect(core).toContain("!isReputationSetupV2(agent.key)");
    expect(core).toContain("buildReputationAgentContextFiles(input.clientId, agent.name)");
  });

  it("gates on the ROSTER, never on the response ledger", () => {
    // An empty ledger is correct for a set-up client who has never had a pulse.
    // Gating on it would refuse every first run.
    expect(context).toMatch(/kind === "roster" && row\.content\.trim\(\)\.length > 0/);
    expect(context).not.toMatch(/hasReputationV2Setup[\s\S]{0,400}response-ledger/);
  });

  it("uses no Zod, and clears every cleared field by hand", () => {
    expect(actions).not.toMatch(/\bzod\b|\bz\./);
    // The clear pass must key on the RAW input, never a parse result: keying a
    // list on its parsed length turns an answer we failed to read into a delete.
    for (const field of [
      "reviewSurfaces",
      "reviewMarkets",
      "reputationContext",
      "crisisRoutingTag",
      "responseNoGos",
    ]) {
      expect(actions, `${field} is never cleared`).toContain(`drop.push("${field}")`);
    }
    expect(actions).toContain("clearAgentIntakeFields(existing.id, drop)");
  });

  // The egress allowlist / tinyproxy filter / task-type grant for the five
  // review platforms was asserted here, reading agent-service/config. That
  // directory was removed along with the service's deploy workflows, so its
  // proxy configuration is frozen at whatever the running revisions were built
  // with and this can no longer drift. Recoverable at 942218f.
});
