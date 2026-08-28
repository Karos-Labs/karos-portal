import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { launchProfileFor, withEngineRunFields } from "@/lib/custom-agent-launch";
import {
  isClientEnabledForEngineCustomAgents,
  resolveAgentEngineProductId,
  resolveAgentEngineProductIdForCustomAgent,
  resolveAgentEngineRunKind,
  toEngineRunInput,
} from "../product-mapping";

describe("resolveAgentEngineProductId", () => {
  it("maps landing_page directly onto landing-builder-agent, brief-independent", () => {
    expect(resolveAgentEngineProductId("landing_page", { page_goal: "leads" })).toBe("landing-builder-agent");
    expect(resolveAgentEngineProductId("landing_page", {})).toBe("landing-builder-agent");
  });

  it("maps social_post + platform:instagram onto instagram-agent", () => {
    expect(resolveAgentEngineProductId("social_post", { platform: "instagram" })).toBe("instagram-agent");
  });

  it("maps social_post + platform:tiktok onto branded-shorts-agent", () => {
    expect(resolveAgentEngineProductId("social_post", { platform: "tiktok" })).toBe("branded-shorts-agent");
  });

  it("is case-insensitive on platform", () => {
    expect(resolveAgentEngineProductId("social_post", { platform: "Instagram" })).toBe("instagram-agent");
    expect(resolveAgentEngineProductId("social_post", { platform: "TIKTOK" })).toBe("branded-shorts-agent");
  });

  it("returns undefined for social_post with no recognized platform — never a guess", () => {
    expect(resolveAgentEngineProductId("social_post", {})).toBeUndefined();
    expect(resolveAgentEngineProductId("social_post", { platform: "facebook" })).toBeUndefined();
    expect(resolveAgentEngineProductId("social_post", { platform: 42 })).toBeUndefined();
  });

  it("returns undefined for custom agent jobs — agent-engine has no mechanism to run a user-authored spec", () => {
    expect(resolveAgentEngineProductId("custom", { agent_key: "x-agent" })).toBeUndefined();
  });
});

describe("resolveAgentEngineProductIdForCustomAgent", () => {
  it("routes the three drafting agents that have engine workflows", () => {
    expect(resolveAgentEngineProductIdForCustomAgent("karos-x-agent-v2")).toBe("x-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-linkedin-writer-v2")).toBe("linkedin-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-reddit-runner")).toBe("reddit-agent");
  });

  it("routes the three agents whose engine workflows already existed", () => {
    expect(resolveAgentEngineProductIdForCustomAgent("karos-instagram-agent")).toBe("instagram-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("landing-builder")).toBe("landing-builder-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("branded-shorts")).toBe("branded-shorts-agent");
  });


  it("only ever maps to a product id the engine can resolve", () => {
    // The guard against the whole class of mistake above. Mirrors
    // KNOWN_PRODUCT_IDS in apps/agent-server/src/wiring/workflows.ts.
    const KNOWN = new Set([
      "x-agent", "instagram-agent", "linkedin-agent", "reddit-agent", "blog-agent",
      "newsletter-agent", "campaign-orchestrator", "landing-builder-agent",
      "branded-shorts-agent", "reputation-agent", "seo-geo-agent", "intel-report-agent",
      "tiktok-agent",
    ]);
    for (const key of [
      "karos-x-agent-v2", "karos-linkedin-writer-v2", "karos-reddit-runner",
      "karos-linkedin-setup-v2", "karos-reddit-setup", "karos-instagram-agent",
      "landing-builder", "branded-shorts", "karos-blog-writer-v2",
      "karos-newsletter-writer-v2", "karos-reputation-runner", "seo-geo-agent-v2",
      "karos-tiktok-agent",
    ]) {
      const productId = resolveAgentEngineProductIdForCustomAgent(key);
      expect(KNOWN.has(productId!), `${key} -> ${productId}`).toBe(true);
    }
  });

  it("routes the two onboarding keys to the drafting agents that now absorb them", () => {
    // These used to route to `linkedin-setup-agent`/`reddit-setup-agent`, which
    // were separate engine products. The setup routine is now each parent
    // agent's `00-channel-setup` pre-flight: the same filled form arrives on
    // the same run, the parent records it if the channel has no charter and
    // skips it if one exists, and then drafts.
    //
    // Still not a prefix match — the mapping is exact, so a key is routed
    // because someone decided it should be and not because its name happened
    // to start the right way.
    expect(resolveAgentEngineProductIdForCustomAgent("karos-linkedin-setup-v2")).toBe("linkedin-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-reddit-setup")).toBe("reddit-agent");
  });

  it("routes the three drafting agents whose engine workflows were built but idle", () => {
    expect(resolveAgentEngineProductIdForCustomAgent("karos-blog-writer-v2")).toBe("blog-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-newsletter-writer-v2")).toBe("newsletter-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("karos-reputation-runner")).toBe("reputation-agent");
  });

  it("routes seo-geo-agent-v2 to the same workflow the research dispatch already uses", () => {
    // This one closes a split rather than opening a route: seo-geo-agent was
    // already live in production via dispatch-research-agents.ts while this
    // custom agent still ran the agent-service implementation, so a client
    // could get either depending on which surface they came through.
    expect(resolveAgentEngineProductIdForCustomAgent("seo-geo-agent-v2")).toBe("seo-geo-agent");
  });

  it("routes the TikTok agent to its own clip workflow, never to branded-shorts", () => {
    // The two are different products: branded-shorts turns one talking-head
    // video into one short, tiktok-agent clips a moment out of someone else's
    // long-form episode. Pointing this at branded-shorts-agent was the
    // tempting shortcut while no tiktok-agent existed.
    expect(resolveAgentEngineProductIdForCustomAgent("karos-tiktok-agent")).toBe("tiktok-agent");
    expect(resolveAgentEngineProductIdForCustomAgent("branded-shorts")).toBe("branded-shorts-agent");
  });

  it("leaves the manager variants and the agents with no engine workflow on agent-service", () => {
    // The managers are the structural blocker, not an oversight:
    // karos-linkedin-manager-v2 runs on two clocks and rewrites the
    // generators' inputs, and agent-engine has neither a scheduler nor a write
    // path for that. The rest simply have no engine product built yet.
    for (const key of [
      "karos-linkedin-manager-v2",
      "karos-blog-manager-v2",
      "karos-newsletter-manager-v2",
      "karos-reputation-manager",
      "karos-carousel-manager",
      "karos-carousel-runner",
      "karos-carousel-setup",
      "karos-blog-setup-v2",
      "karos-newsletter-setup-v2",
      "karos-reputation-setup",
      "karos-compliance-lock-v2",
    ]) {
      expect(resolveAgentEngineProductIdForCustomAgent(key), key).toBeUndefined();
    }
  });

  it("does not route an unknown key", () => {
    expect(resolveAgentEngineProductIdForCustomAgent("something-new")).toBeUndefined();
    expect(resolveAgentEngineProductIdForCustomAgent("")).toBeUndefined();
  });
});

describe("toEngineRunInput — custom prompt and media", () => {
  it("carries a typed direction through as customPrompt", () => {
    expect(toEngineRunInput({ customPrompt: "  lean harder on the counterpoint  " })).toEqual({
      customPrompt: "lean harder on the counterpoint",
    });
  });

  it("omits a blank direction entirely rather than sending an empty string", () => {
    // An agent handed "" would have to decide whether that means "no
    // direction" or "no strategy". Absent means the first, unambiguously.
    expect(toEngineRunInput({ customPrompt: "   " })).toEqual({});
  });

  it("parses attached media and defaults the role to source", () => {
    const out = toEngineRunInput({
      mediaAssets: JSON.stringify([{ uri: "gs://bucket/ep12.mp4" }]),
    });
    expect(out.mediaAssets).toEqual([{ uri: "gs://bucket/ep12.mp4", role: "source" }]);
  });

  it("keeps a recognized role, contentType and label", () => {
    const out = toEngineRunInput({
      mediaAssets: JSON.stringify([
        { uri: "https://cdn.example.com/logo.png", role: "logo", contentType: "image/png", label: "Primary mark" },
      ]),
    });
    expect(out.mediaAssets).toEqual([
      { uri: "https://cdn.example.com/logo.png", role: "logo", contentType: "image/png", label: "Primary mark" },
    ]);
  });

  it("drops anything that is not a gs:// or https:// asset", () => {
    // A local path is meaningless to a container that has never seen this
    // machine's disk, and the rest is a caller sending something we have no
    // reason to forward.
    const out = toEngineRunInput({
      mediaAssets: JSON.stringify([
        { uri: "/tmp/local.mp4" },
        { uri: "file:///etc/passwd" },
        { role: "source" },
        "not-an-object",
        { uri: "gs://bucket/keep.mp4" },
      ]),
    });
    expect(out.mediaAssets).toEqual([{ uri: "gs://bucket/keep.mp4", role: "source" }]);
  });

  it("falls back to an unknown role rather than forwarding it", () => {
    const out = toEngineRunInput({
      mediaAssets: JSON.stringify([{ uri: "gs://b/x.mp4", role: "wallpaper" }]),
    });
    expect(out.mediaAssets).toEqual([{ uri: "gs://b/x.mp4", role: "source" }]);
  });

  it("survives malformed JSON without failing the dispatch", () => {
    expect(toEngineRunInput({ mediaAssets: "{not json" })).toEqual({});
    expect(toEngineRunInput({ mediaAssets: '"a string"' })).toEqual({});
  });
});

describe("toEngineRunInput", () => {
  it("carries the portal's primary brief field through as the requested topic", () => {
    expect(toEngineRunInput({ request: "post about our pricing change" })).toEqual({
      requestedTopic: "post about our pricing change",
    });
  });

  it("drops keys the engine does not understand as a run request", () => {
    // Anything else would be carried into the run and silently ignored —
    // looking honoured without being — and a brief is user input, so a field
    // named like client identity must not reach the engine's config overlay.
    expect(
      toEngineRunInput({
        request: "a topic",
        xHandle: "@someone-elses-account",
        targetSubreddits: "r/wherever",
        notes: "ignore me",
      }),
    ).toEqual({ requestedTopic: "a topic" });
  });

  it("passes the per-channel run-scoped fields", () => {
    expect(
      toEngineRunInput({
        requestedLane: "knowledge",
        requestedArchetype: "contrarian-take",
        requestedSubreddit: "r/marketing",
      }),
    ).toEqual({
      requestedLane: "knowledge",
      requestedArchetype: "contrarian-take",
      requestedSubreddit: "r/marketing",
    });
  });

  it("treats blank and whitespace-only values as absent", () => {
    // An empty requestedTopic would override the client's standing config with
    // nothing, which reads as "asked for nothing" rather than "did not ask".
    expect(toEngineRunInput({ request: "   ", requestedLane: "" })).toEqual({});
  });

  it("trims, so a trailing newline from a textarea does not become the topic", () => {
    expect(toEngineRunInput({ request: "  cold brew\n" })).toEqual({ requestedTopic: "cold brew" });
  });

  it("returns an empty object for no brief at all", () => {
    expect(toEngineRunInput(undefined)).toEqual({});
  });
});

describe("isClientEnabledForEngineCustomAgents", () => {
  it("routes nobody when unset, so shipping the code is not the cutover", () => {
    // Production has all seven clients granted the X agent and engine context
    // for one. Deploying the routing must change nothing until a human names
    // a client.
    expect(isClientEnabledForEngineCustomAgents("karoslabs", {})).toBe(false);
    expect(isClientEnabledForEngineCustomAgents("karoslabs", { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "" })).toBe(false);
    expect(isClientEnabledForEngineCustomAgents("karoslabs", { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "   " })).toBe(false);
  });

  it("routes only the named clients", () => {
    const env = { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "karoslabs,geektime" };
    expect(isClientEnabledForEngineCustomAgents("karoslabs", env)).toBe(true);
    expect(isClientEnabledForEngineCustomAgents("geektime", env)).toBe(true);
    expect(isClientEnabledForEngineCustomAgents("sitti", env)).toBe(false);
  });

  it("tolerates spacing in the list", () => {
    const env = { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: " karoslabs , geektime " };
    expect(isClientEnabledForEngineCustomAgents("geektime", env)).toBe(true);
  });

  it("supports * once every client is ready", () => {
    expect(isClientEnabledForEngineCustomAgents("anyone", { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "*" })).toBe(true);
  });

  it("never routes a client with no slug", () => {
    // agentsRepoSlug is what the engine resolves its workspace against; without
    // one there is no tenant to run as.
    expect(isClientEnabledForEngineCustomAgents(undefined, { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "*" })).toBe(false);
  });

  it("does not match on a prefix", () => {
    const env = { AGENT_ENGINE_CUSTOM_AGENT_CLIENTS: "karos" };
    expect(isClientEnabledForEngineCustomAgents("karoslabs", env)).toBe(false);
  });
});

describe("resolveAgentEngineRunKind", () => {
  it("sends landing-builder a first build, not a rebuild", () => {
    // agent-engine's landing-builder reads runKind "recurring" as MODE=rebuild
    // and blocks on a feedback round. Verified in prep: the same brief resolves
    // to blocked_intake as "recurring" and reaches the copy/compose stages as
    // "setup".
    expect(resolveAgentEngineRunKind("landing-builder-agent")).toBe("setup");
  });

  it("leaves every other product on recurring", () => {
    for (const productId of ["x-agent", "instagram-agent", "branded-shorts-agent", "linkedin-agent", "reddit-agent"]) {
      expect(resolveAgentEngineRunKind(productId), productId).toBe("recurring");
    }
  });

});

// ---------------------------------------------------------------------------
// T-B12 / SCRUM-266 — the run dialog's fields actually reach the engine.
//
// C3 (SCRUM-211), ratified 2026-08-28: "Every field that appears in the run
// dialog reaches the agent and influences the prompt — or it is deleted from
// the dialog." Before this change `toEngineRunInput` allow-listed eight keys
// and every dialog dropped most of what it collected.
// ---------------------------------------------------------------------------

/**
 * The engine-routed custom agents, with a display name that resolves the same
 * launch profile the portal resolves in production, and that profile's exact
 * VISIBLE field list.
 *
 * The field list is written out rather than derived so a profile gaining a
 * field fails HERE, loudly, instead of quietly acquiring a control that goes
 * nowhere — which is the defect this ticket exists to close.
 */
const ENGINE_ROUTED_DIALOGS: ReadonlyArray<{
  key: string;
  name: string;
  productId: string;
  visibleFields: readonly string[];
}> = [
  { key: "karos-x-agent-v2", name: "X Agent", productId: "x-agent", visibleFields: ["run_scope", "request", "customPrompt"] },
  { key: "karos-linkedin-writer-v2", name: "LinkedIn Writer", productId: "linkedin-agent", visibleFields: ["li_identity", "request", "customPrompt"] },
  { key: "karos-linkedin-setup-v2", name: "LinkedIn Setup", productId: "linkedin-agent", visibleFields: ["li_identity", "request", "customPrompt"] },
  { key: "karos-reddit-runner", name: "Reddit Runner", productId: "reddit-agent", visibleFields: ["request", "customPrompt"] },
  { key: "karos-reddit-setup", name: "Reddit Setup", productId: "reddit-agent", visibleFields: ["request", "audience", "success_criteria", "customPrompt"] },
  { key: "karos-instagram-agent", name: "Instagram Agent", productId: "instagram-agent", visibleFields: ["run_mode", "request", "platform", "post_count", "audience", "must_include", "customPrompt", "mediaAssets"] },
  { key: "karos-tiktok-agent", name: "TikTok Agent", productId: "tiktok-agent", visibleFields: ["run_mode", "request", "platform", "post_count", "audience", "must_include", "customPrompt", "mediaAssets"] },
  { key: "branded-shorts", name: "Branded Shorts", productId: "branded-shorts-agent", visibleFields: ["request", "source_url", "platform", "duration", "cta", "editing_notes", "customPrompt", "mediaAssets"] },
  { key: "landing-builder", name: "Landing Page Builder", productId: "landing-builder-agent", visibleFields: ["request", "offer", "audience", "cta", "proof", "references", "customPrompt"] },
  { key: "karos-blog-writer-v2", name: "Blog Writer", productId: "blog-agent", visibleFields: ["run_mode", "request", "audience", "keywords", "point_of_view", "sources", "customPrompt"] },
  { key: "karos-newsletter-writer-v2", name: "Newsletter Writer", productId: "newsletter-agent", visibleFields: ["request", "audience", "must_include", "cta", "tone", "customPrompt"] },
  { key: "karos-reputation-runner", name: "Reputation Runner", productId: "reputation-agent", visibleFields: ["request", "customPrompt"] },
  { key: "seo-geo-agent-v2", name: "SEO GEO Agent", productId: "seo-geo-agent", visibleFields: ["website", "scope", "request", "market", "competitors", "customPrompt"] },
];

/** A plausible answer for one dialog field — typed where the field is typed. */
function answerFor(key: string): string {
  if (key === "post_count") return "7";
  if (key === "mediaAssets") return '[{"uri": "gs://bucket/probe-mediaAssets.mp4", "role": "source"}]';
  if (key === "source_url" || key === "references" || key === "sources") {
    return `https://example.com/probe-${key}`;
  }
  return `probe-${key}`;
}

describe("toEngineRunInput — every visible dialog field reaches the engine (C3 principle)", () => {
  for (const dialog of ENGINE_ROUTED_DIALOGS) {
    it(`${dialog.key} → ${dialog.productId}`, () => {
      // The PAGE's own resolution and the SERVER's are the same call, on the
      // same key. C3's second mandatory fix, pinned rather than assumed.
      const pageProductId = resolveAgentEngineProductIdForCustomAgent(dialog.key);
      expect(pageProductId).toBe(dialog.productId);

      // The dialog exactly as the page builds it: the agent's profile plus the
      // engine-only fields withEngineRunFields appends for this product.
      const profile = withEngineRunFields(launchProfileFor(dialog), pageProductId);
      expect(profile.fields.filter((f) => !f.hidden).map((f) => f.key)).toEqual([...dialog.visibleFields]);

      const answers = Object.fromEntries(
        profile.fields.filter((f) => !f.hidden).map((f) => [f.key, answerFor(f.key)]),
      );
      const full = JSON.stringify(toEngineRunInput(answers, pageProductId));

      // Coverage stated so it cannot be faked by a substring match: dropping
      // ANY visible answer must change what the engine is sent. A field that
      // is silently discarded produces an identical payload, and that is
      // exactly what every one of these did before T-B12.
      for (const field of dialog.visibleFields) {
        const without = { ...answers };
        delete without[field];
        expect(
          JSON.stringify(toEngineRunInput(without, pageProductId)),
          `${dialog.key}: "${field}" is rendered in the run dialog but changes nothing in the engine input`,
        ).not.toBe(full);
      }
    });
  }

  it("and the guard is not vacuous: a key that is NOT in the dialog changes nothing", () => {
    // The same probe run against a key the dialog never shows. If this failed,
    // the sweep above would pass for any string whatsoever and would prove
    // nothing about the fields it names.
    const answers = { request: "probe-request", audience: "probe-audience" };
    expect(JSON.stringify(toEngineRunInput({ ...answers, xHandle: "@someone" }, "x-agent"))).toBe(
      JSON.stringify(toEngineRunInput(answers, "x-agent")),
    );
  });

  it("batch_size never reaches the engine, visible or not", () => {
    // Hidden in every profile that declares it, pricing-inert by product
    // ruling, and deleted outright by C3's x-agent and linkedin-agent rows.
    expect(toEngineRunInput({ request: "a topic", batch_size: "5" }, "x-agent")).toEqual({
      requestedTopic: "a topic",
    });
  });
});

describe("toEngineRunInput — the C3 wire shape", () => {
  it("converts the shared brief fields snake_case → camelCase, in one place", () => {
    expect(
      toEngineRunInput(
        {
          request: "the pricing change",
          audience: "heads of growth",
          tone: "plain and specific",
          cta: "book a demo",
          must_include: "the new price\nthe migration date, and the grace period",
          keywords: "pricing, packaging\nseat-based",
        },
        "linkedin-agent",
      ),
    ).toEqual({
      requestedTopic: "the pricing change",
      audience: "heads of growth",
      tone: "plain and specific",
      cta: "book a demo",
      // newline-split only: a must-include item is allowed to contain commas
      mustInclude: ["the new price", "the migration date, and the grace period"],
      // a single-line text input, so commas separate too
      keywords: ["pricing", "packaging", "seat-based"],
    });
  });

  it("folds the generic profile's success_criteria into the same mustInclude list", () => {
    // karos-reddit-setup resolves to the GENERIC profile, whose constraints box
    // is `success_criteria`. Without this it would be shown and dropped.
    expect(
      toEngineRunInput({ must_include: "a link", success_criteria: "no superlatives" }, "reddit-agent"),
    ).toEqual({ mustInclude: ["a link", "no superlatives"] });
  });

  it("carries the per-agent dedicated fields under their wire names", () => {
    expect(toEngineRunInput({ run_scope: "the company page" }, "x-agent")).toEqual({ runScope: "the company page" });
    expect(toEngineRunInput({ li_identity: "company" }, "linkedin-agent")).toEqual({ liIdentity: "company" });
    expect(toEngineRunInput({ run_mode: "single" }, "blog-agent")).toEqual({ runMode: "single" });
    expect(
      toEngineRunInput({ offer: "a free audit", proof: "three case studies" }, "landing-builder-agent"),
    ).toEqual({ offer: "a free audit", proof: "three case studies" });
    expect(
      toEngineRunInput({ website: "https://x.test", scope: "technical", market: "US", competitors: "acme.test" }, "seo-geo-agent"),
    ).toEqual({ website: "https://x.test", scope: "technical", market: "US", competitors: "acme.test" });
  });

  it("sends post_count as a number, and only a sane one", () => {
    expect(toEngineRunInput({ post_count: "3" }, "instagram-agent")).toEqual({ postCount: 3 });
    expect(toEngineRunInput({ post_count: "0" }, "instagram-agent")).toEqual({});
    expect(toEngineRunInput({ post_count: "three" }, "instagram-agent")).toEqual({});
  });

  it("normalizes targetDate and never throws on a bad one", () => {
    // A date-only answer stays date-only: widening it to midnight UTC moves the
    // publish a day for anyone west of UTC, and delivery reads this.
    expect(toEngineRunInput({ target_date: "2026-09-01" }, "linkedin-agent")).toEqual({ targetDate: "2026-09-01" });
    expect(toEngineRunInput({ target_date: "2026-09-01T08:30:00Z" }, "linkedin-agent")).toEqual({
      targetDate: "2026-09-01T08:30:00.000Z",
    });
    expect(toEngineRunInput({ target_date: "next tuesday" }, "linkedin-agent")).toEqual({});
    expect(() => toEngineRunInput({ target_date: "%%%" }, "linkedin-agent")).not.toThrow();
  });

  it("folds prose-only answers into customPrompt, base direction first", () => {
    expect(
      toEngineRunInput(
        {
          customPrompt: "lean on the counterpoint",
          point_of_view: "we ran the migration ourselves",
        },
        "blog-agent",
      ),
    ).toEqual({
      customPrompt: "lean on the counterpoint\n\nBrand point of view and proof\nwe ran the migration ourselves",
    });
    expect(toEngineRunInput({ editing_notes: "cut the intro" }, "branded-shorts-agent")).toEqual({
      customPrompt: "Editing notes\ncut the intro",
    });
  });

  it("folds link lists into mediaAssets, and the non-link remainder into customPrompt", () => {
    expect(
      toEngineRunInput(
        { sources: "https://example.com/study\nverify the 40% claim", mediaAssets: '[{"uri":"gs://b/a.png","role":"logo"}]' },
        "blog-agent",
      ),
    ).toEqual({
      mediaAssets: [
        { uri: "gs://b/a.png", role: "logo" },
        { uri: "https://example.com/study", role: "reference" },
      ],
      customPrompt: "Required sources or internal links\nverify the 40% claim",
    });
    expect(toEngineRunInput({ source_url: "https://example.com/ep12" }, "branded-shorts-agent")).toEqual({
      mediaAssets: [{ uri: "https://example.com/ep12", role: "source" }],
    });
  });

  it("treats seo-geo's request box as direction, not a topic — per C3's row", () => {
    expect(toEngineRunInput({ request: "why are high-intent pages not converting" }, "seo-geo-agent")).toEqual({
      customPrompt: "Business goal or question\nwhy are high-intent pages not converting",
    });
    // Every other product keeps `request` as the requested topic.
    expect(toEngineRunInput({ request: "why are high-intent pages not converting" }, "blog-agent")).toEqual({
      requestedTopic: "why are high-intent pages not converting",
    });
  });
});

describe("page/server engineProductId consistency (C3 mandatory fix #2)", () => {
  it("the server hands toEngineRunInput the same id the page built the dialog from", () => {
    // A source pin rather than a convention: submit-custom.ts resolves
    // `engineProductId` with the same function custom-agents.tsx passes to
    // withEngineRunFields, and must forward it. Without the second argument
    // the server builds seo-geo's input from a dialog whose `request` box the
    // page labelled "Business goal or question".
    const source = readFileSync(
      resolve(__dirname, "../../jobs/submit-custom.ts"),
      "utf8",
    );
    expect(source).toContain("resolveAgentEngineProductIdForCustomAgent(agent.key)");
    expect(source).toContain("toEngineRunInput(input.briefValues, engineProductId)");
  });

  it("every routed product has a dialog pinned above, so a new route cannot ship unswept", () => {
    const swept = new Set(ENGINE_ROUTED_DIALOGS.map((d) => d.key));
    for (const key of [
      "karos-x-agent-v2", "karos-linkedin-writer-v2", "karos-reddit-runner",
      "karos-linkedin-setup-v2", "karos-reddit-setup", "karos-instagram-agent",
      "landing-builder", "branded-shorts", "karos-blog-writer-v2",
      "karos-newsletter-writer-v2", "karos-reputation-runner", "seo-geo-agent-v2",
      "karos-tiktok-agent",
    ]) {
      expect(swept.has(key), `${key} routes to agent-engine but has no dialog-coverage case`).toBe(true);
    }
  });
});
