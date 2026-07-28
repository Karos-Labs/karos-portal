import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("custom agent launch profiles", () => {
  it("gives known agents purpose-built fields and attachment guidance", () => {
    const instagram = launchProfileFor({ key: "karos-instagram-agent", name: "Instagram Agent" });
    // A linkedin-ish import that is NOT an e10 agent still gets the founder brief.
    const linkedin = launchProfileFor({ key: "acme-linkedin-ghostwriter", name: "LinkedIn Ghostwriter" });
    const shorts = launchProfileFor({ key: "branded-shorts", name: "Branded Shorts" });
    const x = launchProfileFor({ key: "karos-x-agent", name: "X Agent" });

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
    expect(x.fields.map((field) => field.key)).toEqual(["run_scope", "request"]);
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
    expect(clientSafeRunError("AGENT_SERVICE_CALLBACK_URL (or NEXT_PUBLIC_APP_URL) must be set for webhook callbacks.")).toBe(
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
    for (const key of ["karos-x-agent", "karos-reddit-agent", "branded-shorts"]) {
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
    const hub = src.slice(start, src.indexOf("client-page section", start));

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
