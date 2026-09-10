import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOG_ENVELOPE_KIND,
  blogEnvelopeHasContent,
  blogStateContentType,
  blogStateDateFor,
  blogStateKindFor,
  buildBlogEnvelope,
  isBlogEnvelope,
} from "@/lib/agent-service/blog-state-capture";
import {
  newsletterIssueNumberFrom,
  newsletterLedgerKindFor,
} from "@/lib/agent-service/newsletter-state-capture";
import {
  BLOG_MANAGER_V2_KEY,
  BLOG_RUN_CREDITS,
  BLOG_SETUP_V2_KEY,
  BLOG_WRITER_V2_KEY,
  isBlogAgentIdentity,
  isSubAgent,
  isUnlistedAgent,
} from "@/lib/custom-agent-launch";

/**
 * Blog v2's own guarantees, and the cross-product handoff that is unique to it.
 * Pure: the envelope assembler, the two state matchers, the key predicates.
 * Server modules are `server-only`, so anything that has to agree across the RSC
 * boundary is asserted through its source.
 */

const RUN = "clients/xodigital/outputs/blog-agent-v2/2026-08-11-post-004";

describe("the blog v2 keys", () => {
  it("names the WRITER as the agent and the other two as its steps", () => {
    // THREE skills, not four: there is no blog compliance lock. The blog reuses
    // the newsletter's, whose behaviour the framework re-decides — it stops
    // hand-editing blog posts, because the site tree is derived now and a hand
    // fix would be overwritten by the next press.
    expect(isBlogAgentIdentity(BLOG_WRITER_V2_KEY)).toBe(true);
    for (const key of [BLOG_SETUP_V2_KEY, BLOG_MANAGER_V2_KEY]) {
      // NOT the agent: this predicate decides who gets the blog intake and the
      // setup gate, and a setup run that gated on its own output could never run.
      expect(isBlogAgentIdentity(key), key).toBe(false);
      expect(isSubAgent({ key, parentKey: BLOG_WRITER_V2_KEY }), key).toBe(true);
      expect(isUnlistedAgent({ key, parentKey: BLOG_WRITER_V2_KEY }), key).toBe(true);
    }
    expect(isUnlistedAgent({ key: BLOG_WRITER_V2_KEY })).toBe(false);
  });

  it("kept the managed product's price after the managed product was deleted", () => {
    expect(BLOG_RUN_CREDITS).toBe(10);
    const credits = readFileSync(join(process.cwd(), "src/lib/credits.ts"), "utf8");
    expect(credits).toContain("export const BLOG_RUN_CREDITS = 10");
    // The deleted managed row has not crept back. Two prices for one product is
    // the drift this arrangement exists to prevent.
    expect(credits, "the retired managed price is back in TASK_EXECUTION_COSTS").not.toMatch(
      /^\s*blog_article: \d+,/m,
    );
    // Still quoted to the client by name, at the same number.
    expect(credits).toContain('{ label: "Blog article", credits: BLOG_RUN_CREDITS }');
  });
});

describe("the newsletter ledger — the handoff the blog reads", () => {
  it("matches the two published files by DIRECTORY, not by base name", () => {
    // Both names carry the issue number, so there is no fixed base name to key
    // on and a pattern assuming three digits or a date format would silently
    // drop a real handoff. The directory is the contract.
    const items = "clients/xo/outputs/_ledger/newsletter-issues/2026-08-11-issue-004-items.json";
    const scan = "clients/xo/outputs/_ledger/seven-day-scan/2026-08-11-issue-004.json";
    expect(newsletterLedgerKindFor(items)).toBe("issue-items");
    expect(newsletterLedgerKindFor(scan)).toBe("scan-log");
    expect(newsletterIssueNumberFrom(items)).toBe("004");
    expect(newsletterIssueNumberFrom(scan)).toBe("004");
  });

  it("takes nothing outside _ledger, and nothing that is not JSON", () => {
    for (const p of [
      // The newsletter's OWN state, which has its own capture and its own
      // collection. Catching it here would write it into the ledger too.
      "clients/xo/skills/newsletter-agent-v2/issue-index.json",
      // The run's internal trail — the framework forbids the blog reaching into
      // another product's internals, and the handoff file exists so it need not.
      "clients/xo/outputs/newsletter-agent-v2/2026-08-11-issue-004/internal/07-draft.json",
      // A ledger file that is not one of the two.
      "clients/xo/outputs/_ledger/deliverables.jsonl",
      "clients/xo/outputs/_ledger/newsletter-issues/README.md",
    ]) {
      expect(newsletterLedgerKindFor(p), p).toBeNull();
    }
  });

  it("preserves the issue number's zero padding, because it is a join key", () => {
    // Three rows and the issue index all key on this string. "004" and "4" are
    // different keys, so nothing may normalise it on the way in.
    expect(newsletterIssueNumberFrom("a/_ledger/newsletter-issues/x-issue-004-items.json")).toBe("004");
    expect(newsletterIssueNumberFrom("a/_ledger/seven-day-scan/x-issue-012.json")).toBe("012");
    expect(newsletterIssueNumberFrom("a/_ledger/newsletter-issues/no-number.json")).toBeNull();
  });
});

describe("which blog artifacts are durable state", () => {
  it("recognises all five contract files", () => {
    const cases: Array<[string, string]> = [
      ["clients/xo/skills/blog-agent-v2/post-index.json", "post-index"],
      ["clients/xo/skills/blog-agent-v2/clusters.json", "clusters"],
      ["clients/xo/skills/blog-agent-v2/voice-card.md", "voice-card"],
      ["clients/xo/skills/blog-agent-v2/v1-posts.json", "v1-posts"],
      ["clients/xo/skills/blog-agent-v2/next-request.md", "next-request"],
    ];
    for (const [path, kind] of cases) {
      expect(blogStateKindFor(path), path).toBe(kind);
    }
  });

  it("REFUSES the run's frozen copies and the DERIVED site tree", () => {
    // Step 02 pins every standing document it reads into internal/inputs/.
    // Capturing one writes the pre-run state over the post-run state — and for
    // the post index that un-claims a number the run just took.
    expect(blogStateKindFor(`${RUN}/internal/inputs/post-index.json`)).toBeNull();
    expect(blogStateKindFor(`${RUN}/internal/02-inputs/clusters.json`)).toBeNull();
    // And the site tree, which the newsletter's twin has no equivalent of. Step
    // 13 rebuilds `clients/<slug>/blog/` from completed runs; those per-post
    // JSON files are RENDER PAYLOADS, not state, and one whose name collided
    // would overwrite a real file with a rendering artifact.
    expect(blogStateKindFor("clients/xo/blog/posts/some-slug/clusters.json")).toBeNull();
    // The live paths are captured.
    expect(blogStateKindFor("clients/xo/skills/blog-agent-v2/post-index.json")).toBe("post-index");
  });

  it("types each file the way its reader expects, and dates from the path", () => {
    expect(blogStateContentType("a/post-index.json")).toBe("application/json");
    expect(blogStateContentType("a/voice-card.md")).toBe("text/markdown");
    const t = new Date("2026-08-12T00:02:00Z").getTime();
    expect(blogStateDateFor(`${RUN}/internal/x.json`, t)).toBe("2026-08-11");
    expect(blogStateDateFor("clients/xo/skills/blog-agent-v2/clusters.json", t)).toBe("2026-08-12");
  });
});

describe("the deliverable envelope", () => {
  const files = [
    { path: `${RUN}/client/01-tokenized-bonds/tokenized-bonds.html`, text: "<html>page</html>" },
    { path: `${RUN}/client/01-tokenized-bonds/tokenized-bonds-body.html`, text: "<h2>fragment</h2>" },
    { path: `${RUN}/client/01-tokenized-bonds/tokenized-bonds.md`, text: "# the markdown" },
    { path: `${RUN}/client/01-tokenized-bonds/about.txt`, text: "CONFIRM FIRST: the yield figure." },
    { path: `${RUN}/client/01-tokenized-bonds/publish-notes.txt`, text: "Meta title: …" },
  ];

  it("keeps all five files, which the size heuristic could not", () => {
    const env = buildBlogEnvelope(files);
    expect(env.kind).toBe(BLOG_ENVELOPE_KIND);
    expect(env.html).toBe("<html>page</html>");
    expect(env.bodyHtml).toBe("<h2>fragment</h2>");
    expect(env.markdown).toBe("# the markdown");
    expect(env.about).toContain("CONFIRM FIRST");
    expect(env.publishNotes).toContain("Meta title");
    expect(env.postNumber).toBe("01");
    expect(env.slug).toBe("tokenized-bonds");
  });

  it("does not let the CMS fragment claim the standalone page's slot", () => {
    // `<slug>-body.html` also ends in `.html`. Testing for the page first would
    // match both, and the client would receive the fragment as their whole page
    // or the page as their fragment — and the two are near-identical in LENGTH,
    // so the size race this envelope replaces would have picked between them on
    // how much chrome the template happened to add.
    const env = buildBlogEnvelope([files[1], files[0]]);
    expect(env.html).toBe("<html>page</html>");
    expect(env.bodyHtml).toBe("<h2>fragment</h2>");
  });

  it("survives a partial delivery rather than producing a false-empty asset", () => {
    const env = buildBlogEnvelope([files[0]]);
    expect(blogEnvelopeHasContent(env)).toBe(true);
    expect(env.bodyHtml).toBeUndefined();
    expect(blogEnvelopeHasContent(buildBlogEnvelope([]))).toBe(false);
    expect(
      blogEnvelopeHasContent(buildBlogEnvelope([{ path: "a/about.txt", text: "  " }])),
    ).toBe(false);
  });

  it("sniffs its own envelope and no sibling's", () => {
    expect(isBlogEnvelope(JSON.stringify(buildBlogEnvelope(files)))).toBe(true);
    expect(isBlogEnvelope('{"kind":"newsletter-issue-v2","html":"x"}')).toBe(false);
    expect(isBlogEnvelope('{"kind":"reddit-drafts-v2","threads":[]}')).toBe(false);
    expect(isBlogEnvelope("")).toBe(false);
  });
});

describe("the wiring that has to agree across modules", () => {
  const core = readFileSync(join(process.cwd(), "src/lib/jobs/submit-custom.ts"), "utf8");
  const context = readFileSync(
    join(process.cwd(), "src/lib/agent-service/blog-agent-context.ts"),
    "utf8",
  );
  const campaign = readFileSync(join(process.cwd(), "src/lib/campaign-engine.ts"), "utf8");
  const webhook = readFileSync(
    join(process.cwd(), "src/app/api/agent-service/webhook/route.ts"),
    "utf8",
  );

  it("gates on the intake AND on setup having produced a post index", () => {
    expect(core).toContain("hasBlogAgentIntake(input.clientId)");
    expect(core).toContain("hasBlogV2Setup(input.clientId)");
    // The setup skill is exempt: it is the job that makes the index.
    expect(core).toContain("!isBlogSetupV2(agent.key)");
    expect(core).toContain("buildBlogAgentContextFiles(input.clientId, agent.name)");
  });

  it("injects the NEWSLETTER's research, not just the blog's own state", () => {
    // The one cross-product injection in the portal. Without it the blog has an
    // issue index pointing at handoff files that no longer exist, because the
    // newsletter's workspace died with its runner.
    expect(context).toContain("listNewsletterLedger(clientId)");
    expect(context).toContain("BLOG_NEWSLETTER_WINDOW");
    // And the SHARED foundation is re-injected from the newsletter's captured
    // copy rather than stored a second time under a blog kind.
    expect(context).toContain('getNewsletterAgentState(clientId, "content-foundation")');
  });

  it("captures the ledger on the NEWSLETTER's delivery, keyed per issue", () => {
    expect(webhook).toContain("newsletterLedgerKindFor(liPath)");
    expect(webhook).toContain("upsertNewsletterLedgerEntry");
    // The issue markdown comes off the envelope rather than a second fetch, so
    // the blog reads exactly the text the client was given.
    expect(webhook).toContain('kind: "issue-markdown"');
  });

  it("routes the campaign ANCHOR to the blog agent, and deduplicates on the executor", () => {
    expect(campaign).toContain("customAgentKey: BLOG_WRITER_V2_KEY");
    // THE ORDERING IS THE ASSERTION. Both the anchor and the newsletter carry
    // productType "custom", and `executorKey` reads `customAgentId ?? productType`
    // — so resolving keys to ids AFTER the dedup pass made the two look like one
    // executor and dropped whichever came second, silently removing the
    // newsletter from every campaign.
    expect(campaign.indexOf("const customByKey")).toBeLessThan(
      campaign.indexOf("findDuplicateReason("),
    );
    expect(campaign).toContain("executorIdentity");
  });
});
