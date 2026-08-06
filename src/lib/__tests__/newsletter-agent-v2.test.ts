import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NEWSLETTER_ENVELOPE_KIND,
  buildNewsletterEnvelope,
  isNewsletterEnvelope,
  newsletterEnvelopeHasContent,
  newsletterStateContentType,
  newsletterStateDateFor,
  newsletterStateKindFor,
} from "@/lib/agent-service/newsletter-state-capture";
import {
  COMPLIANCE_LOCK_V2_KEY,
  NEWSLETTER_MANAGER_V2_KEY,
  NEWSLETTER_RUN_CREDITS,
  NEWSLETTER_SETUP_V2_KEY,
  NEWSLETTER_WRITER_V2_KEY,
  isNewsletterAgentIdentity,
  isSubAgent,
  isUnlistedAgent,
} from "@/lib/custom-agent-launch";

/**
 * Newsletter v2's own guarantees. Pure: the envelope assembler, the state
 * matcher, the key predicates. The server module is `server-only`, so anything
 * that has to agree across the RSC boundary is asserted through its source.
 */

const RUN = "clients/xodigital/outputs/newsletter-agent-v2/2026-08-11-issue-004";

describe("the newsletter v2 keys", () => {
  it("names the WRITER as the agent and the other three as its steps", () => {
    // Four skills, one product. The compliance lock is its own registered skill
    // here rather than a step inside the writer, which is new versus LinkedIn (3)
    // and Reddit (2) — but from the portal's side it is still just a step.
    expect(isNewsletterAgentIdentity(NEWSLETTER_WRITER_V2_KEY)).toBe(true);
    for (const key of [NEWSLETTER_SETUP_V2_KEY, NEWSLETTER_MANAGER_V2_KEY, COMPLIANCE_LOCK_V2_KEY]) {
      // NOT the agent: this predicate decides who gets the newsletter intake and
      // the setup gate, and a setup run that gated on its own output could never
      // run at all.
      expect(isNewsletterAgentIdentity(key), key).toBe(false);
      // Hidden structurally once seeded, never by a hardcoded list.
      expect(isSubAgent({ key, parentKey: NEWSLETTER_WRITER_V2_KEY }), key).toBe(true);
      expect(isUnlistedAgent({ key, parentKey: NEWSLETTER_WRITER_V2_KEY }), key).toBe(true);
    }
    expect(isUnlistedAgent({ key: NEWSLETTER_WRITER_V2_KEY })).toBe(false);
  });

  it("carries the managed product's price rather than re-deriving one", () => {
    // The work per issue did not change when the product moved off the managed
    // path, so a client's bill must not either. Without an explicit default it
    // would fall to the generic custom-agent rate the moment newsletter_issue is
    // deleted — a silent repricing nobody decided.
    expect(NEWSLETTER_RUN_CREDITS).toBe(10);
    const credits = readFileSync(join(process.cwd(), "src/lib/credits.ts"), "utf8");
    expect(credits, "the managed price this is carried FROM has moved").toContain(
      "newsletter_issue: 10",
    );
  });
});

describe("which artifacts are durable state", () => {
  it("recognises all five contract files", () => {
    const cases: Array<[string, string]> = [
      ["clients/xo/skills/newsletter-agent-v2/issue-index.json", "issue-index"],
      ["clients/xo/skills/newsletter-agent-v2/topic-pool.json", "topic-pool"],
      ["clients/xo/skills/newsletter-agent-v2/voice-card.md", "voice-card"],
      ["clients/xo/skills/newsletter-agent-v2/scan-topics.json", "scan-topics"],
      ["clients/xo/skills/_shared/CONTENT-FOUNDATION.md", "content-foundation"],
    ];
    for (const [path, kind] of cases) {
      expect(newsletterStateKindFor(path), path).toBe(kind);
    }
  });

  it("REFUSES the run's frozen copies, which is the whole safety of the capture", () => {
    // Writer step 02 pins every standing document it reads into internal/inputs/.
    // Capturing one writes the pre-run state back over the post-run state — and
    // for the issue index that un-ships a claim the run just made, silently.
    expect(newsletterStateKindFor(`${RUN}/internal/inputs/issue-index.json`)).toBeNull();
    expect(newsletterStateKindFor(`${RUN}/internal/02-inputs/topic-pool.json`)).toBeNull();
    // The live path is captured.
    expect(newsletterStateKindFor("clients/xo/skills/newsletter-agent-v2/issue-index.json")).toBe(
      "issue-index",
    );
  });

  it("ignores the deliverable and the internal trail", () => {
    for (const p of [
      `${RUN}/client/01-issue-004/issue-004.html`,
      `${RUN}/internal/07-draft.json`,
      `${RUN}/internal/issue-004.json`,
    ]) {
      expect(newsletterStateKindFor(p), p).toBeNull();
    }
  });

  it("types each file the way its reader expects", () => {
    expect(newsletterStateContentType("a/issue-index.json")).toBe("application/json");
    expect(newsletterStateContentType("a/voice-card.md")).toBe("text/markdown");
  });

  it("dates from the path when it has one", () => {
    const t = new Date("2026-08-12T00:02:00Z").getTime();
    expect(newsletterStateDateFor(`${RUN}/internal/x.json`, t)).toBe("2026-08-11");
    expect(newsletterStateDateFor("clients/xo/skills/newsletter-agent-v2/voice-card.md", t)).toBe(
      "2026-08-12",
    );
  });
});

describe("the deliverable envelope", () => {
  const files = [
    { path: `${RUN}/client/01-issue-004/issue-004.html`, text: "<html>dark</html>" },
    { path: `${RUN}/client/01-issue-004/issue-004-light.html`, text: "<html>light</html>" },
    { path: `${RUN}/client/01-issue-004/issue-004.md`, text: "the plain text version" },
    { path: `${RUN}/client/01-issue-004/about.txt`, text: "CONFIRM FIRST: the footer wording.\nTwo lines." },
  ];

  it("keeps all four files, which the size heuristic could not", () => {
    // The largest text file here is one of the two HTML renders. Letting the size
    // race pick would call half the deliverable the whole of it and drop the rest.
    const env = buildNewsletterEnvelope(files);
    expect(env.kind).toBe(NEWSLETTER_ENVELOPE_KIND);
    expect(env.html).toBe("<html>dark</html>");
    expect(env.htmlLight).toBe("<html>light</html>");
    expect(env.text).toBe("the plain text version");
    expect(env.about).toContain("CONFIRM FIRST");
    expect(env.issueNumber).toBe("004");
  });

  it("does not let the light variant claim the dark slot", () => {
    // issue-004-light.html also ends in .html. Testing for the dark one first
    // would match both and the second would overwrite the first.
    const env = buildNewsletterEnvelope([files[1], files[0]]);
    expect(env.html).toBe("<html>dark</html>");
    expect(env.htmlLight).toBe("<html>light</html>");
  });

  it("survives a partial delivery rather than producing a false-empty asset", () => {
    const env = buildNewsletterEnvelope([files[0]]);
    expect(newsletterEnvelopeHasContent(env)).toBe(true);
    expect(env.htmlLight).toBeUndefined();
    // Nothing at all IS empty, and the caller must not store an asset for it.
    expect(newsletterEnvelopeHasContent(buildNewsletterEnvelope([]))).toBe(false);
    expect(
      newsletterEnvelopeHasContent(buildNewsletterEnvelope([{ path: "a/about.txt", text: "   " }])),
    ).toBe(false);
  });

  it("sniffs its own envelope and no one else's", () => {
    const json = JSON.stringify(buildNewsletterEnvelope(files));
    expect(isNewsletterEnvelope(json)).toBe(true);
    expect(isNewsletterEnvelope('{"kind":"reddit-drafts-v2","threads":[]}')).toBe(false);
    expect(isNewsletterEnvelope("# LinkedIn drafts")).toBe(false);
    expect(isNewsletterEnvelope("")).toBe(false);
  });
});

describe("the runner gets the credential the scan actually reads", () => {
  it("aliases CLAUDE_API_KEY from the Anthropic key, and allowlists it", () => {
    // The scan reads process.env.CLAUDE_API_KEY for its ranking call and DEGRADES
    // SILENTLY without it — a quietly worse issue, not an error anyone sees. It is
    // the same Anthropic credential, so it is aliased rather than given a second
    // secret to rotate and forget.
    const worker = readFileSync(
      join(process.cwd(), "agent-service/src/queue/worker.ts"),
      "utf8",
    );
    expect(worker).toContain("env.CLAUDE_API_KEY = config.anthropicApiKey");
    const runner = readFileSync(
      join(process.cwd(), "agent-service/runner/src/main.ts"),
      "utf8",
    );
    // Present in the sandbox allowlist, or the worker setting it changes nothing.
    expect(runner).toContain('"CLAUDE_API_KEY"');
  });
});

describe("the fourth intake family", () => {
  const views = readFileSync(join(process.cwd(), "src/lib/agent-intake-views.ts"), "utf8");
  const rows = readFileSync(join(process.cwd(), "src/lib/client-agent-rows.ts"), "utf8");
  const hub = readFileSync(join(process.cwd(), "src/components/custom-agents.tsx"), "utf8");

  it("carries null through to the browser instead of resolving it to a day", () => {
    // The one field on any of these four projections copied unconditionally.
    // Absent means "never seen the form"; null means "looked at it and did not
    // choose" — and the framework requires the second be carried, not defaulted.
    // A conditional spread erases exactly that distinction at the RSC boundary.
    expect(views).toContain("preferredWeekday: intake.preferredWeekday ?? null");
    expect(views).not.toMatch(/preferredWeekday \? \{ preferredWeekday/);
  });

  it("answers `ready` with BOTH rungs, unlike the other three", () => {
    // Elsewhere `ready` means "form saved" and the stand-up travels separately.
    // Here the writer claims an issue number at step 01, so a run without an
    // index is charged for and dies — and the submit core gates on both, so a
    // one-rung answer here would offer a run the server refuses.
    expect(rows).toContain("hasNewsletterAgentIntake(clientId)");
    expect(rows).toContain("hasNewsletterV2Setup(clientId)");
    expect(rows).toContain("ready: hasIntake && isSetUp");
  });

  it("has no implicit fallback left in the kind switch", () => {
    // Both used to end in a bare Reddit return, so a fourth family would have
    // been relabelled on the way through — and `intakeFor` is upstream of the
    // title, the glyph, the copy AND the form, so all four would have agreed
    // with each other and all been wrong.
    for (const kind of ["x", "linkedin", "reddit", "newsletter"]) {
      expect(hub, `intakeFor has no explicit ${kind} branch`).toContain(
        `if (setup.kind === "${kind}")`,
      );
      expect(hub, `IntakeForm has no explicit ${kind} branch`).toContain(
        `if (intake.kind === "${kind}")`,
      );
    }
    // Every per-kind table answers for all four, or the Record type is a lie
    // the way a trailing return was.
    for (const table of ["INTAKE_LABEL", "INTAKE_ROUTE", "INTAKE_ASKS", "INTAKE_FIRST_STEP"]) {
      const body = hub.slice(hub.indexOf(`const ${table}: Record<IntakeKind`));
      expect(body.slice(0, body.indexOf("};")), table).toContain("newsletter:");
    }
  });

  it("treats the newsletter's stand-up like LinkedIn's, not like Reddit's", () => {
    expect(hub).toContain('if (intake.kind !== "linkedin" && intake.kind !== "newsletter") return true');
    // And the refusal the submit core actually sends has a way back to the form,
    // rather than the "contact us" row a missing prefix produces.
    expect(hub).toContain("refusal.startsWith(NEWSLETTER_SETUP_REQUIRED_PREFIX)");
    expect(hub).toContain("error.startsWith(NEWSLETTER_SETUP_REQUIRED_PREFIX)");
  });
});

describe("the submit core", () => {
  const core = readFileSync(join(process.cwd(), "src/lib/jobs/submit-custom.ts"), "utf8");

  it("gates on the intake AND on setup having produced an issue index", () => {
    // Two different questions. The form being saved does not mean the client has
    // an index, and the writer claims a number in that index at its very first
    // step — so without the second rung a client pays for a run that dies at 01.
    expect(core).toContain("hasNewsletterAgentIntake(input.clientId)");
    expect(core).toContain("hasNewsletterV2Setup(input.clientId)");
    // The setup skill is exempt: it is the job that creates the index.
    expect(core).toContain("!isNewsletterSetupV2(agent.key)");
  });

  it("injects the state files and carries the price", () => {
    expect(core).toContain("buildNewsletterAgentContextFiles(input.clientId, agent.name)");
    expect(core).toContain("NEWSLETTER_RUN_CREDITS");
    // An admin's explicit price still wins; this only replaces the null default.
    expect(core).toContain("agent.creditCost ?? newsletterDefault ?? CREDIT_COSTS.customAgentRun");
  });
});
