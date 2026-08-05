import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: buildAgentSetup and the LinkedIn predicate are server modules, and
// the readiness/core-agreement test below drives them for real against a
// stubbed data layer. Every other test in this file only reads source.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");

import {
  ALL_LAUNCH_PROFILES,
  agentKeyMatchesClientSlug,
  buildCustomAgentPrompt,
  clientSafeRunError,
  initialAgentBrief,
  launchProfileFor,
  X_SETUP_REQUIRED_PREFIX,
} from "@/lib/custom-agent-launch";
import { CREDIT_DENIAL_PREFIX } from "@/lib/credits";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import * as data from "@/lib/data";
import { buildAgentSetup } from "@/lib/client-agent-rows";
import { hasLinkedInAgentIntake } from "@/lib/agent-service/linkedin-agent-context";
import type { AgentIntake } from "@/lib/types";

describe("custom agent launch profiles", () => {
  it("gives known agents purpose-built fields and attachment guidance", () => {
    const instagram = launchProfileFor({ key: "karos-instagram-agent", name: "Instagram Agent" });
    // A linkedin-ish import that is NOT an e10 agent still gets the founder brief.
    const linkedin = launchProfileFor({ key: "acme-linkedin-ghostwriter", name: "LinkedIn Ghostwriter" });
    const shorts = launchProfileFor({ key: "branded-shorts", name: "Branded Shorts" });
    const x = launchProfileFor({ key: "karos-x-agent-v2", name: "X Agent" });

    expect(instagram.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(["run_mode", "request", "platform", "post_count"]),
    );
    expect(linkedin.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(["executive", "request", "proof"]),
    );
    expect(shorts.attachments.required).toBe(true);
    expect(shorts.attachments.satisfyWithFieldKey).toBe("source_url");
    // The X agent is intake-driven (its agent data holds handles, off-limits,
    // rosters, takes) — the launch brief only scopes the run. It must never
    // ask for things the agent BUILDS (audience, themes, cadence) or already
    // stores (account handles).
    expect(x.fields.map((field) => field.key)).toEqual(["run_scope", "batch_size", "request"]);
    expect(x.fields.map((field) => field.key)).not.toEqual(
      expect.arrayContaining(["account", "audience", "themes", "cadence"]),
    );
    expect(new Set([instagram.eyebrow, linkedin.eyebrow, shorts.eyebrow, x.eyebrow]).size).toBe(4);
  });

  it("routes the e10 LinkedIn agents to the intake-driven brief, before the founder regex", () => {
    // The per-client company-page instance and the lab master are both
    // intake-driven (setup gate + injected LinkedIn agent data): the brief
    // only scopes the run, exactly like the X agent — never asking for what
    // the agent data already stores (executive material, voice, proof).
    const instance = launchProfileFor({
      key: "karos-linkedin-company-karoslabs",
      name: "LinkedIn Company Page — Karos Labs",
    });
    const master = launchProfileFor({ key: "karos-linkedin-agent", name: "LinkedIn Agent" });
    for (const profile of [instance, master]) {
      expect(profile.eyebrow).toBe("LinkedIn drafts");
      expect(profile.fields.map((field) => field.key)).toEqual(["request"]);
      expect(profile.fields.map((field) => field.key)).not.toEqual(
        expect.arrayContaining(["executive", "proof", "voice_constraints"]),
      );
    }
  });

  it("routes the e15 Reddit agent to its own intake-driven brief", () => {
    const reddit = launchProfileFor({ key: "karos-reddit-agent", name: "Reddit Agent" });
    expect(reddit.eyebrow).toBe("Reddit reply");
    // Intake-driven, so the brief only scopes the run. It must never ask for
    // what the agent BUILDS (the subreddit roster, the questions worth
    // answering, the voice) or already stores (the account and its history).
    expect(reddit.fields.map((field) => field.key)).toEqual(["request"]);
    expect(reddit.fields.map((field) => field.key)).not.toEqual(
      expect.arrayContaining(["account", "subreddits", "voice", "thread_url"]),
    );
    // The reply is a hand-off, never a publish: the brief must promise that.
    expect(reddit.intro).toMatch(/never post to Reddit|you post the reply yourself/i);

    // Exact-key matching keeps a lookalike import on the generic brief, and
    // keeps the Reddit brief from hijacking agents whose descriptions mention
    // monitoring, listening or research.
    expect(launchProfileFor({ key: "acme-reddit-ghostwriter", name: "Reddit Ghostwriter" }).eyebrow).toBe(
      "Reddit Ghostwriter work order",
    );
    expect(
      launchProfileFor({ key: "karos-reputation", name: "Brand Reputation Monitoring" }).eyebrow,
    ).toBe("Reputation brief");
  });

  it("keeps unknown imported agents runnable with a complete fallback brief", () => {
    const profile = launchProfileFor({ key: "future-agent", name: "Future Agent" });
    expect(profile.fields.find((field) => field.key === "request")?.required).toBe(true);
    expect(profile.fields.map((field) => field.key)).toContain("success_criteria");
    expect(profile.attachments.label).toBe("Reference files");
  });

  it("does not let broad words route specialized agents to the wrong brief", () => {
    const amazon = launchProfileFor({ key: "karos-amazon-mgmt", name: "Amazon Listing & Ads Management" });
    const reputation = launchProfileFor({ key: "karos-reputation", name: "Brand Reputation Monitoring" });
    const intel = launchProfileFor({ key: "karos-intel", name: "Digital Intelligence Report" });

    expect(amazon.eyebrow).toBe("Marketplace brief");
    expect(reputation.eyebrow).toBe("Reputation brief");
    expect(intel.eyebrow).toBe("Market intelligence brief");
  });

  it("ships no unsubstituted template placeholder to a user", () => {
    // A chip reading "Focus this batch on [person]'s seat." both advertises an
    // unfinished feature and, when clicked, puts the literal "[person]" into
    // the agent's prompt. Sweep every string a person can read on the run
    // dialog, across every profile.
    const PLACEHOLDER = /\[[a-z_]+\]/;
    const offenders: string[] = [];
    for (const profile of ALL_LAUNCH_PROFILES) {
      const strings = [
        profile.eyebrow,
        profile.intro,
        profile.estimate,
        ...profile.quickStarts,
        ...profile.deliverables,
        profile.attachments.label,
        profile.attachments.hint,
        ...profile.fields.flatMap((field) => [
          field.label,
          field.placeholder,
          field.helper,
          ...(field.options ?? []).map((option) => option.label),
        ]),
      ];
      for (const value of strings) {
        if (value && PLACEHOLDER.test(value)) offenders.push(`${profile.eyebrow}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("serializes guided answers into the service prompt without losing labels", () => {
    const profile = launchProfileFor({ key: "acme-linkedin-ghostwriter", name: "LinkedIn Ghostwriter" });
    const values = {
      ...initialAgentBrief(profile),
      executive: "Maya Chen, CEO",
      request: "Explain the lesson from our enterprise rollout.",
      audience: "Operations leaders",
    };
    const prompt = buildCustomAgentPrompt(profile, values);

    expect(prompt).toContain("Executive or account\nMaya Chen, CEO");
    expect(prompt).toContain("Point of view or outcome\nExplain the lesson");
    expect(prompt).toContain("Audience\nOperations leaders");
  });
});

describe("clientSafeRunError", () => {
  it("hides the submit core's config strings from a client run dialog", () => {
    const raw = "Agent service is not configured (AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN).";
    const safe = clientSafeRunError(raw);
    expect(safe).not.toContain("AGENT_SERVICE_URL");
    expect(safe).not.toBe(raw);
    expect(clientSafeRunError("AGENT_SERVICE_CALLBACK_URL (or APP_URL) must be set for webhook callbacks.")).toBe(
      safe,
    );
  });

  it("passes setup refusals and credit denials through verbatim", () => {
    const setup = `${X_SETUP_REQUIRED_PREFIX} first. Open the "X agent data" page.`;
    expect(clientSafeRunError(setup)).toBe(setup);
    const denial = `${CREDIT_DENIAL_PREFIX.insufficient_balance} 25 credits and 3 are left.`;
    expect(clientSafeRunError(denial)).toBe(denial);
  });
});

describe("managed product launch profiles", () => {
  it("keeps every managed agent's brief and file request distinct", () => {
    const fieldSignatures = MANAGED_PRODUCTS.map((product) =>
      product.briefFields.map((field) => field.key).join(","),
    );
    const fileLabels = MANAGED_PRODUCTS.map((product) => product.inputFiles.label);

    expect(new Set(fieldSignatures).size).toBe(MANAGED_PRODUCTS.length);
    expect(new Set(fileLabels).size).toBe(MANAGED_PRODUCTS.length);
  });

  it("exposes the richer schema-backed landing-page inputs", () => {
    const landing = MANAGED_PRODUCTS.find((product) => product.taskType === "landing_page");
    expect(landing?.briefFields.map((field) => field.key)).toEqual([
      "page_goal",
      "offer",
      "sections",
      "reference_urls",
    ]);
    expect(landing?.briefFields.find((field) => field.key === "reference_urls")?.valueKind).toBe(
      "stringList",
    );
  });
});


/**
 * F38. The staff hub is the one surface that pairs an ARBITRARY agent with an
 * arbitrary client, so it is the one that can assemble a pair both submit cores
 * refuse. Until now that refusal arrived only after the whole brief had been
 * written and submitted. The eligibility rule the hub filters on is asserted
 * here; the source test below pins that the hub actually applies it.
 */
describe("staff hub client eligibility", () => {
  const CLIENTS = [
    { id: "c1", name: "Geektime", agentsRepoSlug: "geektime" },
    { id: "c2", name: "Karos Labs", agentsRepoSlug: "karoslabs" },
    { id: "c3", name: "New Client", agentsRepoSlug: null },
  ];
  const eligibleFor = (agentKey: string) =>
    CLIENTS.filter((c) => agentKeyMatchesClientSlug(agentKey, c.agentsRepoSlug)).map((c) => c.name);

  it("narrows a per-client instance to exactly its own client", () => {
    expect(eligibleFor("karos-linkedin-company-karoslabs")).toEqual(["Karos Labs"]);
  });

  it("leaves an unbound agent runnable for every client, slug or not", () => {
    for (const key of ["karos-x-agent-v2", "karos-reddit-agent", "branded-shorts"]) {
      expect(eligibleFor(key)).toEqual(["Geektime", "Karos Labs", "New Client"]);
    }
  });

  it("yields nobody for an instance whose client is not in the visible set", () => {
    // An employee sees only their assigned clients, so this is reachable
    // without anything being wrong in the data — the Run button is disabled
    // rather than offering a pair that cannot run.
    expect(eligibleFor("karos-linkedin-company-sitti")).toEqual([]);
  });
});

describe("the hub applies that rule to the controls it paints", () => {
  it("filters the picker, states the binding, and disables an unrunnable Run", () => {
    const src = readFileSync(join(process.cwd(), "src/components/custom-agents.tsx"), "utf8");
    const start = src.indexOf("export function CustomAgentsHub");
    expect(start).toBeGreaterThan(-1);
    // The next top-level declaration. The marker this used to slice on
    // ("client-page section") is not in the file at all, so the slice ran to
    // EOF and every assertion below was free to be answered by any component in
    // it — including ones this test says nothing about.
    const end = src.indexOf("\nfunction refusalNamesSetup", start);
    // An end marker that has moved silently widens the slice to the rest of the
    // file, and every assertion below would then be answered by code this test
    // is not about.
    expect(end, "custom-agents.tsx no longer has the slice end marker").toBeGreaterThan(start);
    const hub = src.slice(start, end);

    // The eligible set is computed per agent card...
    expect(hub).toContain("agentKeyMatchesClientSlug(agent.key, c.agentsRepoSlug)");
    // ...gates the Run control...
    expect(hub).toContain("eligible.length === 0");
    // ...names the binding on the card (F35)...
    expect(hub).toContain("perClientAgentSlug(agent.key)");
    // ...and the dialog receives the filtered list, never the raw one.
    expect(hub).toContain("agentKeyMatchesClientSlug(runAgent.key, c.agentsRepoSlug)");
    expect(hub).not.toMatch(/clients=\{clients\}/);
  });
});


/**
 * Ruling 7. One keyed map carries BOTH routes to an agent's intake: `href` (the
 * agent's own data page — always present, and what the client's detail route
 * offers) and `kind`/`data` (the prefetched form the run dialog collects in
 * place). The alternative that was on the table — three per-platform props
 * beside the map — made every consumer re-derive which agent is which, which is
 * a second place for "is this the LinkedIn agent" to disagree with the server.
 */
describe("AgentSetupState carries the href card and the inline pane", () => {
  const rows = readFileSync(join(process.cwd(), "src/lib/client-agent-rows.ts"), "utf8");
  const ui = readFileSync(join(process.cwd(), "src/components/custom-agents.tsx"), "utf8");

  it("always resolves an href, pane or no pane", () => {
    // Three agents, three hrefs, and none of them conditional on a payload.
    for (const route of ["x-agent", "linkedin-agent", "reddit-agent"]) {
      expect(rows).toContain(`/clients/\${clientId}/${route}`);
    }
    expect(rows).toContain("{ ready, href, label, clientLabel }");
  });

  it("attaches a prefetched form to the agent it belongs to", () => {
    for (const kind of ["x", "linkedin", "reddit"]) {
      expect(rows).toContain(`kind: "${kind}", data: panes.${kind}`);
    }
  });

  it("keeps ready answered by the submit cores' own predicates", () => {
    // The page builds the FORMS; readiness stays with the calls the cores gate
    // on. Two independent answers to "is this set up" is how a card starts
    // offering a run the server refuses.
    expect(rows).toContain("hasXAgentIntake(clientId)");
    expect(rows).toContain("hasLinkedInAgentIntake(clientId, agent.key)");
    expect(rows).toContain("hasRedditAgentIntake(clientId)");
  });

  it("carries the agent key at the CORES' call sites, not only the card's", () => {
    // This is the assertion that binds. Pinning only client-agent-rows.ts left
    // the gate free to drift on the side that actually refuses: both cores
    // called hasLinkedInAgentIntake UNKEYED while the test above stayed green,
    // so a seat-only workspace read `ready` on the card, cleared schedule-gate
    // (which IS keyed) and then died inside the core on a company form the
    // Path-B master does not have — after the card had promised a run. Every
    // consumer of the keyed predicate passes the key, or they do not agree.
    for (const file of [
      "src/lib/client-agent-rows.ts",
      "src/lib/jobs/submit-custom.ts",
      "src/lib/agent-service/run-custom-agent.ts",
      "src/lib/jobs/schedule-gate.ts",
      // The launch path. It answers the same question one rung earlier — may
      // this umbrella be stood up at all — so an unkeyed call here refuses a
      // Path-B master's LAUNCH while the card, the cores and the gate all agree
      // it is ready.
      "src/lib/actions/client-agent-actions.ts",
    ]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      const calls = [...src.matchAll(/hasLinkedInAgentIntake\(([^)]*)\)/g)].map((m) => m[1]);
      expect(calls.length, `${file} never calls hasLinkedInAgentIntake`).toBeGreaterThan(0);
      for (const args of calls) {
        expect(args, `${file} calls hasLinkedInAgentIntake without the agent key`).toContain(
          "agent.key",
        );
      }
    }
  });

  describe("readiness and the core predicate, driven for a seat-only workspace", () => {
    // The source pin above is only worth its line count if the key CHANGES the
    // answer. This drives the real functions against the exact fixture the
    // ruling is about — a LinkedIn workspace set up on the seat side with no
    // company page saved — and shows the two ends agreeing, and the dropped
    // argument disagreeing.
    const CLIENT = "client-seat-only";
    const seatIntake = {
      id: "i1",
      clientId: CLIENT,
      agent: "linkedin",
      seatId: "seat-1",
      handle: "https://linkedin.com/in/someone",
      createdAt: 1,
      updatedAt: 1,
    } as unknown as AgentIntake;

    beforeEach(() => {
      vi.mocked(data.listPlannedScheduledRuns).mockResolvedValue([]);
      // No company page doc; one seat's intake stored.
      vi.mocked(data.getAgentIntake).mockResolvedValue(null);
      vi.mocked(data.listAgentIntake).mockResolvedValue([seatIntake]);
    });

    it("shows the Path-B master ready, and the core predicate says the same", async () => {
      const setup = await buildAgentSetup(CLIENT, [{ id: "a1", key: "karos-linkedin-agent" }]);
      expect(setup.a1.ready).toBe(true);
      // What the core asks, with the key it now passes.
      await expect(hasLinkedInAgentIntake(CLIENT, "karos-linkedin-agent")).resolves.toBe(true);
      // And what it asked before the fix. This is the disagreement itself: the
      // card offers the run, the core refuses it. If this line ever starts
      // returning true the fixture has stopped reproducing the bug.
      await expect(hasLinkedInAgentIntake(CLIENT)).resolves.toBe(false);
    });

    it("still holds the company floor for a company-page instance", async () => {
      // The key is not a blanket pass: an instance WITH a company form of its
      // own is judged on that form, so this same workspace is not-ready there —
      // and both ends say so.
      const setup = await buildAgentSetup(CLIENT, [
        { id: "a2", key: "karos-linkedin-company-karoslabs" },
      ]);
      expect(setup.a2.ready).toBe(false);
      await expect(
        hasLinkedInAgentIntake(CLIENT, "karos-linkedin-company-karoslabs"),
      ).resolves.toBe(false);
    });
  });

  it("leaves the components asking one map, not three payloads", () => {
    expect(ui).toContain("function intakeFor(setup: AgentSetupState | null | undefined)");
    // The per-platform props are gone from the two components' surfaces.
    expect(ui).not.toContain("xSetup?: XAgentSetup;");
    expect(ui).not.toContain("linkedinSetup?: LinkedInAgentSetup;");
    expect(ui).not.toContain("redditSetup?: RedditAgentSetup;");
  });

  it("keeps the href gate for a setup with no prefetched form", () => {
    // The client detail route ships href-only states, so the dialog must still
    // have its way out — and it must not offer an empty pane instead.
    expect(ui).toContain("if (setup && !setup.ready && !intake)");
    expect(ui).toContain("Set up {setup.label}");
    expect(ui).toContain("href={setup.href}");
  });
});
