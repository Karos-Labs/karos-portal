import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAROUSEL_ENVELOPE_KIND,
  buildCarouselEnvelope,
  carouselEnvelopeHasContent,
  carouselStateContentType,
  carouselStateDateFor,
  carouselStateKindFor,
  isCarouselEnvelope,
  isCarouselSlideName,
} from "@/lib/agent-service/carousel-state-capture";
import {
  CAROUSEL_MANAGER_KEY,
  CAROUSEL_RUNNER_KEY,
  CAROUSEL_RUN_CREDITS,
  CAROUSEL_SETUP_KEY,
  isCarouselAgentIdentity,
  isSubAgent,
  isUnlistedAgent,
  launchProfileFor,
} from "@/lib/custom-agent-launch";

/**
 * Carousel v2's own guarantees, plus the Dockerfile fix it depends on. Pure: the
 * envelope assembler, the state matcher, the key predicates, the launch
 * profiles. Server modules are `server-only`, so anything that has to agree
 * across the RSC boundary is asserted through its source.
 */

const RUN = "clients/xodigital/outputs/carousel-agent-v2/2026-08-11-post-004";

// The runner Dockerfile's ESM fix was asserted here, reading
// agent-service/runner/Dockerfile. That directory was removed and the
// service's deploy workflows with it, so the image serving production is the
// last one that will ever be built from this repo and the assertion can no
// longer fail meaningfully. Recoverable at 942218f if the service is ever
// restored.

describe("the carousel v2 keys", () => {
  it("names the RUNNER as the agent and the other two as its steps", () => {
    expect(isCarouselAgentIdentity(CAROUSEL_RUNNER_KEY)).toBe(true);
    for (const key of [CAROUSEL_SETUP_KEY, CAROUSEL_MANAGER_KEY]) {
      expect(isCarouselAgentIdentity(key), key).toBe(false);
      expect(isSubAgent({ key, parentKey: CAROUSEL_RUNNER_KEY }), key).toBe(true);
      expect(isUnlistedAgent({ key, parentKey: CAROUSEL_RUNNER_KEY }), key).toBe(true);
    }
    expect(isUnlistedAgent({ key: CAROUSEL_RUNNER_KEY })).toBe(false);
  });

  it("does NOT claim the legacy Instagram agent", () => {
    // The carousel is described as its modern replacement, but that agent is a
    // separate document with six credentials and its own intake shape. Folding
    // it into this family would attach carousel intake to an agent that reads
    // none of it; retiring it is a deprecation of its own.
    expect(isCarouselAgentIdentity("karos-instagram-agent")).toBe(false);
  });

  it("prices a post as a DECISION, above the two text products", () => {
    expect(CAROUSEL_RUN_CREDITS).toBe(25);
    const credits = readFileSync(join(process.cwd(), "src/lib/credits.ts"), "utf8");
    expect(credits).toContain("export const CAROUSEL_RUN_CREDITS = 25");
    // No rate-card row: 25 IS the generic agent-run rate, which the card's
    // existing "from" line already quotes. A second row would imply the carousel
    // is priced differently from other agents when it is not.
    expect(credits).not.toContain('{ label: "Carousel", credits');
  });
});

describe("the launch profiles", () => {
  it("gives each v2 skill its own brief", () => {
    expect(launchProfileFor({ key: CAROUSEL_RUNNER_KEY, name: "Carousel Agent" }).eyebrow).toBe(
      "Carousel brief",
    );
    expect(launchProfileFor({ key: CAROUSEL_SETUP_KEY, name: "Carousel Setup" }).eyebrow).toBe(
      "Carousel setup",
    );
    expect(launchProfileFor({ key: CAROUSEL_MANAGER_KEY, name: "Carousel Manager" }).eyebrow).toBe(
      "Carousel review",
    );
  });

  it("states the publishing boundary exactly, and asks nothing required", () => {
    const runner = launchProfileFor({ key: CAROUSEL_RUNNER_KEY, name: "Carousel Agent" });
    // The AGENT renders and stops; the PORTAL is what can auto-publish, from an
    // approved asset. Saying "the agent publishes" would promise a capability
    // the runner does not have.
    expect(runner.intro).toContain(
      "Approval-gated drafts; portal auto-publishing available via Next.js execution.",
    );
    expect(runner.fields.every((f) => !f.required)).toBe(true);
  });
});

describe("which artifacts are durable state", () => {
  it("recognises the standing files setup writes", () => {
    const cases: Array<[string, string]> = [
      ["clients/xo/skills/carousel-agent-v2/02-style-config.json", "style-config"],
      ["clients/xo/skills/carousel-agent-v2/brand-tokens.json", "brand-tokens"],
      ["clients/xo/skills/carousel-agent-v2/topic-catalog.yaml", "topic-catalog"],
    ];
    for (const [path, kind] of cases) {
      expect(carouselStateKindFor(path), path).toBe(kind);
    }
  });

  it("takes 03-catalog-state.yaml from internal/, the one carve-out", () => {
    // The integration spec named it; the manifest puts it in the RUN's trail
    // rather than the skills directory. Matched by exact base name so the
    // exception cannot widen, and still refused when it is a PINNED copy.
    expect(carouselStateKindFor(`${RUN}/internal/03-catalog-state.yaml`)).toBe("catalog-state");
    expect(carouselStateKindFor(`${RUN}/internal/inputs/03-catalog-state.yaml`)).toBeNull();
  });

  it("REFUSES everything else in the internal trail", () => {
    for (const p of [
      `${RUN}/internal/inputs/topic-catalog.yaml`,
      `${RUN}/internal/slides-data.json`,
      `${RUN}/internal/09-delivered.md`,
      `${RUN}/internal/02-style-config.json`,
    ]) {
      expect(carouselStateKindFor(p), p).toBeNull();
    }
    expect(carouselStateKindFor("clients/xo/skills/carousel-agent-v2/topic-catalog.yaml")).toBe(
      "topic-catalog",
    );
  });

  it("types YAML as yaml, not as json", () => {
    expect(carouselStateContentType("a/topic-catalog.yaml")).toBe("text/yaml");
    expect(carouselStateContentType("a/02-style-config.json")).toBe("application/json");
    const t = new Date("2026-08-12T00:02:00Z").getTime();
    expect(carouselStateDateFor(`${RUN}/x.yaml`, t)).toBe("2026-08-11");
  });
});

describe("the deliverable envelope", () => {
  const files = [
    { path: `${RUN}/client/01-tokenized-bonds/caption.txt`, text: "Five things nobody tells you." },
    { path: `${RUN}/client/01-tokenized-bonds/about.txt`, text: "CONFIRM: the yield figure." },
  ];
  const slides = [
    `${RUN}/client/01-tokenized-bonds/slide-01.png`,
    `${RUN}/client/01-tokenized-bonds/slide-09.png`,
    `${RUN}/client/01-tokenized-bonds/slide-10.png`,
    `${RUN}/client/01-tokenized-bonds/slide-02.png`,
  ];

  it("carries the text and NAMES the slides, which are images", () => {
    // The slides never pass through asset.content — they are re-hosted like any
    // other image. Naming them lets a reader see ten were made and notice nine
    // arrived, which for a carousel is a broken post rather than a short one.
    const env = buildCarouselEnvelope(files, slides);
    expect(env.kind).toBe(CAROUSEL_ENVELOPE_KIND);
    expect(env.caption).toContain("nobody tells you");
    expect(env.about).toContain("CONFIRM");
    expect(env.postNumber).toBe("01");
    expect(env.slideNames).toEqual(["slide-01.png", "slide-02.png", "slide-09.png", "slide-10.png"]);
  });

  it("sorts slides NUMERICALLY, so 10 follows 9", () => {
    // Lexicographic order puts slide-10 before slide-02, and a client reading
    // that list would think the story is scrambled.
    const env = buildCarouselEnvelope([], slides);
    expect(env.slideNames).toEqual(["slide-01.png", "slide-02.png", "slide-09.png", "slide-10.png"]);
  });

  it("counts SLIDES ALONE as content", () => {
    // A run whose caption failed but whose slides rendered produced the
    // expensive half, and the images are on the asset regardless of this string.
    const env = buildCarouselEnvelope([], slides);
    expect(env.caption).toBeUndefined();
    expect(carouselEnvelopeHasContent(env)).toBe(true);
    expect(carouselEnvelopeHasContent(buildCarouselEnvelope([], []))).toBe(false);
  });

  it("recognises a slide by name, and nothing else", () => {
    expect(isCarouselSlideName("slide-01.png")).toBe(true);
    expect(isCarouselSlideName(`${RUN}/client/01-x/slide-10.webp`)).toBe(true);
    expect(isCarouselSlideName("caption.txt")).toBe(false);
    expect(isCarouselSlideName("slides-data.json")).toBe(false);
    expect(isCarouselSlideName("slide-cover.png")).toBe(false);
  });

  it("sniffs its own envelope and no sibling's", () => {
    expect(isCarouselEnvelope(JSON.stringify(buildCarouselEnvelope(files, slides)))).toBe(true);
    expect(isCarouselEnvelope('{"kind":"reputation-pulse-v2"}')).toBe(false);
    expect(isCarouselEnvelope('{"kind":"blog-post-v2"}')).toBe(false);
    expect(isCarouselEnvelope("")).toBe(false);
  });
});

describe("the wiring that has to agree across modules", () => {
  const core = readFileSync(join(process.cwd(), "src/lib/jobs/submit-custom.ts"), "utf8");
  const context = readFileSync(
    join(process.cwd(), "src/lib/agent-service/carousel-agent-context.ts"),
    "utf8",
  );
  const actions = readFileSync(
    join(process.cwd(), "src/lib/actions/carousel-agent-actions.ts"),
    "utf8",
  );
  const webhook = readFileSync(
    join(process.cwd(), "src/app/api/agent-service/webhook/route.ts"),
    "utf8",
  );

  it("gates on the intake AND on setup having produced a style config", () => {
    expect(core).toContain("hasCarouselAgentIntake(input.clientId)");
    expect(core).toContain("hasCarouselV2Setup(input.clientId)");
    expect(core).toContain("!isCarouselSetupV2(agent.key)");
    expect(core).toContain("buildCarouselAgentContextFiles(input.clientId, agent.name)");
  });

  it("gates on the STYLE CONFIG, never on the topic catalogue", () => {
    // A styled client whose catalogue is momentarily exhausted is a HELD run
    // with a clear message, not an unconfigured one. Gating on the catalogue
    // would conflate the two.
    expect(context).toMatch(/kind === "style-config" && row\.content\.trim\(\)\.length > 0/);
  });

  it("uses no Zod, and clears every cleared field by hand", () => {
    expect(actions).not.toMatch(/\bzod\b|\bz\./);
    for (const field of ["carouselHandle", "slideCountPreference", "bannedTopics"]) {
      expect(actions, `${field} is never cleared`).toContain(`drop.push("${field}")`);
    }
    expect(actions).toContain("clearAgentIntakeFields(existing.id, drop)");
  });

  it("counts the slides off the ARTIFACT manifest, not the text list", () => {
    // The slides are images, so their bytes never reach the text branch the
    // envelope is otherwise built from. Only the manifest can count them.
    expect(webhook).toContain("isCarouselSlideName(a.name)");
    expect(webhook).toContain("upsertCarouselAgentState");
  });
});
