import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as launch from "@/lib/custom-agent-launch";
import {
  NO_LEVER,
  VISIBILITY_WORK_STANDFIRST,
  citationDomainFor,
  sortVisibilityWorkRows,
  visibilityLeverFamilies,
  visibilityLeverFor,
  visibilityLeverSentences,
  visibilityWorkBand,
} from "@/lib/visibility-levers";
import type { RosterStatus } from "@/lib/client-agents";

/**
 * "What we are doing to improve your SEO and GEO" (round 6, 2026-09).
 *
 * TWO CLOSED QUESTIONS, and they are the two ways a section like this goes
 * wrong:
 *
 *  1. WHAT MAY A SENTENCE CLAIM? The section sits directly under the scores, so
 *     a sentence that promises a number is the report contradicting its own
 *     measurement. The cap is a regex over the table rather than a reviewer's
 *     memory, because the table is exactly the kind of copy that grows one
 *     cheerful line at a time.
 *  2. IS EVERY AGENT ACCOUNTED FOR? A key with no lever silently renders no row,
 *     which is the right behaviour for the SEO/GEO agent (it IS the
 *     measurement) and a silent omission for anything else. So every custom-agent
 *     key either resolves to a lever or is named in `NO_LEVER`, and adding an
 *     agent to either registry without deciding fails here.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

/**
 * The custom-agent keys agent-engine has a workflow for, read out of the ONE
 * place in this repo that names them (`ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY`).
 * Source-scanned because the map is module-private: exporting it to satisfy a
 * test would widen a routing table's surface for no runtime reason.
 */
function engineCustomAgentKeys(): string[] {
  const src = source("src/lib/agent-engine/product-mapping.ts");
  const at = src.indexOf("const ENGINE_PRODUCT_BY_CUSTOM_AGENT_KEY");
  expect(at, "the custom-agent routing table was renamed or moved").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("};", at));
  return [...body.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
}

/**
 * Every agent KEY `custom-agent-launch.ts` exports as a constant. `_FIELD_KEY`
 * names are brief fields, not agents, and are excluded by name rather than by a
 * value heuristic.
 */
function launchAgentKeys(): string[] {
  return Object.entries(launch as Record<string, unknown>)
    .filter(([name]) => /_KEY$/.test(name) && !/_FIELD_KEY$/.test(name))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string");
}

const status = (over: Partial<RosterStatus> = {}): RosterStatus => ({
  tone: "idle",
  label: "Not set up yet",
  ...over,
});

describe("the lever table claims only what it can", () => {
  it("quotes no percentage and promises no outcome", () => {
    // A check measures what is on a page or in a public record; nothing here
    // observes an engine deciding anything. The scores above the section are
    // the only measure of how it is going, and the standfirst says so.
    const banned = [
      { re: /\d+\s*%/, why: "a percentage" },
      { re: /\bwill\b/i, why: '"will"' },
      { re: /\bguarantee/i, why: '"guarantee"' },
      { re: /\bboost/i, why: '"boost"' },
      { re: /\brank/i, why: '"rank"' },
      { re: /\bdouble/i, why: '"double"' },
      { re: /\bgrow your\b/i, why: '"grow your"' },
    ];
    for (const sentence of [...visibilityLeverSentences(), VISIBILITY_WORK_STANDFIRST]) {
      for (const { re, why } of banned) {
        expect(re.test(sentence), `${why} in: ${sentence}`).toBe(false);
      }
    }
  });

  it("uses no dash punctuation, the client-copy rule (AF-8)", () => {
    // The `client-copy-boundary` sweep covers rendered components; this is a
    // pure module, so it carries its own pin.
    // round 6 (decision 7): the family NAMES are client-facing copy too - they
    // are what a "Not on your plan" row prints and what its Support subject
    // says - so they sit under the same rule as the sentences.
    const strings = [
      ...visibilityLeverSentences(),
      VISIBILITY_WORK_STANDFIRST,
      ...visibilityLeverFamilies().map((f) => f.name),
    ];
    for (const sentence of strings) {
      expect(sentence).not.toMatch(/—/);
      expect(sentence).not.toMatch(/ - /);
    }
  });

  it("says what is made and where it lands, in whole sentences", () => {
    for (const sentence of visibilityLeverSentences()) {
      expect(sentence.length).toBeGreaterThan(40);
      expect(sentence.trimEnd().endsWith("."), sentence).toBe(true);
    }
  });
});

describe("every agent is accounted for, one way or the other", () => {
  it("resolves a lever or names the key in NO_LEVER", () => {
    const unaccounted = [...new Set([...engineCustomAgentKeys(), ...launchAgentKeys()])].filter(
      (key) => visibilityLeverFor({ key, name: "" }) === null && !NO_LEVER.includes(key),
    );
    // A key that falls through renders no row and says nothing about why. Give
    // it a sentence, or put it in NO_LEVER with the reason.
    expect(unaccounted).toEqual([]);
  });

  it("keeps the measurement itself out of the section", () => {
    // The SEO/GEO agent produces the numbers this section sits under. A row
    // claiming it improves them would be the report crediting itself; the
    // measurement stamp under the tiles already says when it last ran.
    expect(NO_LEVER).toContain("seo-geo-agent-v2");
    expect(visibilityLeverFor({ key: "seo-geo-agent-v2", name: "SEO GEO Agent" })).toBeNull();
  });

  it("drops an agent nobody wrote a sentence for", () => {
    // Which is also what keeps an unreviewed test agent off a client's report.
    expect(visibilityLeverFor({ key: "karos-experiment-42", name: "Experiment" })).toBeNull();
  });

  it("claims the combined content engine before either single-platform pattern", () => {
    // `karos-instagram-tiktok-content-agent` contains BOTH "instagram" and
    // "tiktok", the same ordering hazard agent-blurbs.ts documents. It is the
    // Instagram row.
    const combined = visibilityLeverFor({
      key: "karos-instagram-tiktok-content-agent-acme",
      name: "Content Engine",
    });
    expect(combined?.family).toBe("social");
    expect(combined?.sentence).toContain("A daily post on your Instagram.");
    const tiktok = visibilityLeverFor({ key: "karos-tiktok-agent", name: "TikTok Agent" });
    expect(tiktok?.sentence).toContain("Short clips for TikTok");
  });

  /**
   * round 6 review (E2): THE AGENTS THAT USED TO VANISH.
   *
   * The clip family was matched by a regex copied out of `agent-archetype.ts`
   * and copied INCOMPLETELY: `CLIENT_MAKER` minus `\bclips?\b` and
   * `\binterview\b`. So a `karos-clip-maker` and an interview clipper matched
   * no rule at all, resolved to no lever, and were silently dropped from a
   * client's report while their own detail page happily rendered a clip gallery.
   * The rule asks `agentArchetype` now — the same resolver that picks the page
   * shape — so the two cannot disagree about which agents make video.
   */
  it("gives a clip maker and an interview clipper a lever", () => {
    for (const subject of [
      { key: "karos-clip-maker", name: "Clip Maker" },
      { key: "karos-interview-clipper", name: "Interview Clipper" },
      { key: "karos-branded-shorts", name: "Branded Shorts" },
    ]) {
      const lever = visibilityLeverFor(subject);
      expect(lever?.family, subject.key).toBe("clips");
      expect(lever?.sentence, subject.key).toContain("Short clips for TikTok");
    }
    // And the flagship is still NOT one of them, whatever its per-client key.
    expect(
      visibilityLeverFor({ key: "karos-instagram-tiktok-content-agent-acme", name: "Engine" })
        ?.family,
    ).toBe("social");
  });

  it("gives each family the lever the table says", () => {
    const sentenceFor = (key: string) => visibilityLeverFor({ key, name: "" })?.sentence ?? "";
    expect(sentenceFor("karos-blog-writer-v2")).toContain("Articles on your own site");
    expect(sentenceFor("landing-builder")).toContain("One page on your site");
    expect(sentenceFor("karos-linkedin-writer-v2")).toContain("Posts for your company page");
    expect(sentenceFor("karos-reddit-runner")).toContain("One reply a day");
    expect(sentenceFor("karos-x-agent-v2")).toContain("A post a day on X");
    expect(sentenceFor("karos-reputation-runner")).toContain("Drafts replies to your reviews");
    expect(sentenceFor("karos-newsletter-writer-v2")).toContain("the people who already know you");
  });
});

/**
 * DECISION 7, APPROVED: "Reporting section shows agents not on the plan as
 * 'Not on your plan' + Support."
 *
 * Before this, that word was reachable only through `granted: false` on a
 * roster entry - an agent that had delivered work for the client without the
 * grant ever being written, which is rare and is not the case Albert asked
 * about. The section's second source of rows is this table, and what has to
 * hold is that it advertises the CATALOGUE (one row per product) rather than
 * the matcher (one row per regex).
 */
describe("the catalogue half: one row per family, for what the account does not have", () => {
  // round 6 review (E2): ONE ROW PER PRODUCT still, and the Instagram feed
  // engine is one product. What changed is that the CLIP agents are their own
  // product rather than a second sentence hiding inside this one: a family owns
  // exactly one sentence now, and "A daily post on your Instagram" printed over
  // an interview clipper would be a false statement about what a client bought.
  // They are separate lab agents with separate blurbs (`agent-blurbs.ts`), so
  // the catalogue was under-counting products, not over-counting them.
  it("collapses every Instagram pattern into ONE family", () => {
    const families = visibilityLeverFamilies().map((f) => f.family);
    expect(families.filter((f) => f === "social")).toHaveLength(1);
    expect(families.filter((f) => f === "clips")).toHaveLength(1);
    for (const key of ["karos-instagram-tiktok-content-agent-acme", "karos-instagram-agent"]) {
      expect(visibilityLeverFor({ key, name: "" })?.family, key).toBe("social");
    }
  });

  it("lists every family exactly once, in lever order", () => {
    const entries = visibilityLeverFamilies();
    expect(new Set(entries.map((e) => e.family)).size).toBe(entries.length);
    const orders = entries.map((e) => e.lever.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    // round 6 review (E2): `clips` sits beside `social`, in its own lever slot.
    expect(entries.map((e) => e.family)).toEqual([
      "blog",
      "landing",
      "linkedin",
      "reddit",
      "x",
      "social",
      "clips",
      "reputation",
      "newsletter",
    ]);
  });

  it("gives each family a name and a mark to render, since it has no stored agent", () => {
    for (const entry of visibilityLeverFamilies()) {
      // The name is what the row prints and what "Ask about the {name}" says.
      expect(entry.name.length, entry.family).toBeGreaterThan(2);
      expect(entry.name, entry.family).toMatch(/^[A-Z]/);
      // `AgentIdentity` reads this string to pick the platform mark.
      expect(entry.markIdentity, entry.family).toContain(
        entry.family === "social" ? "instagram" : entry.family,
      );
      // ROUND-TRIP: the mark identity has to be a string the matcher itself
      // resolves back to this family, or the row could print one family's name
      // over another family's mark.
      const [key, ...rest] = entry.markIdentity.split(" ");
      const resolved = visibilityLeverFor({ key: key!, name: rest.join(" ") });
      expect(resolved?.family, entry.family).toBe(entry.family);
      expect(resolved?.sentence, entry.family).toBe(entry.lever.sentence);
    }
  });

  it("never advertises the measurement agent or a step of another agent", () => {
    // The two refusals in NO_LEVER must not come back through the catalogue
    // door: a "Not on your plan" row for the SEO/GEO agent would be the report
    // offering to sell the reader the report.
    const advertised = visibilityLeverFamilies().map((e) => e.markIdentity.split(" ")[0]!);
    for (const key of NO_LEVER) expect(advertised, key).not.toContain(key);
    expect(visibilityLeverFamilies().map((e) => e.name)).not.toContain("SEO GEO Agent");
  });

  // round 6 review (D4): the LAST band is "no roster status at all", which is
  // exactly the catalogue row — `status: null`. It used to be a separate
  // `granted` flag read ahead of the tone, which also sent an UNGRANTED ROSTER
  // ROW to the bottom: an agent that has delivered work for this client, has a
  // real status word, filed under "what this account does not have".
  it("bands every catalogue row below every row the account has", () => {
    expect(visibilityWorkBand({ status: null })).toBe(5);
    expect(
      visibilityWorkBand({ status: { tone: "disabled", label: "Coming Soon" } }),
    ).toBeLessThan(5);
  });
});

describe("the section renders a catalogue row without a link", () => {
  // A source pin rather than a render: the section is a server component (see
  // its own note). What must hold is that the Open control asks for an agent id
  // as well as the grant - a catalogue row has `customAgentId: null`, and a
  // Link to `/agents/null` is the 404 risk-review C21 forbids.
  const section = source("src/components/seo-geo/visibility-work.tsx");

  it("gates the Open control on there being something to open", () => {
    // round 6 review (D4/E4): ONE field per decision. `customAgentId` decides
    // the control (null for a catalogue row AND for an ungranted one, whose page
    // would `notFound()`); `status` decides the badge (null is the one row that
    // reads "Not on your plan"). The old `granted` flag decided both, and got
    // the badge wrong.
    expect(section).toContain("{row.customAgentId ?");
    expect(section).toContain("customAgentId: string | null");
    expect(section).toContain("{row.status ?");
    expect(section, "an ungranted roster row keeps its own word").not.toContain("row.granted");
    // The sentence is read off the lever the row already carries, not off a
    // duplicated field beside it.
    expect(section).toContain("{row.lever.sentence}");
  });

  it("keys the list on the row rather than on an agent id that may be null", () => {
    expect(section).toContain("key={row.key}");
  });

  it("still offers Support on every ungranted row", () => {
    expect(section).toContain("subject={`Ask about the ${row.agentName}`}");
  });
});

describe("the measured line only appears where a number exists", () => {
  it("maps each publishing agent onto the domain the leaderboard counts", () => {
    expect(citationDomainFor({ key: "karos-linkedin-writer-v2", name: "" }, "acme.com")).toBe(
      "linkedin.com",
    );
    expect(citationDomainFor({ key: "karos-reddit-runner", name: "" }, "acme.com")).toBe(
      "reddit.com",
    );
    // The two agents that write PAGES put the brand on the client's own domain.
    expect(citationDomainFor({ key: "karos-blog-writer-v2", name: "" }, "acme.com")).toBe(
      "acme.com",
    );
    expect(citationDomainFor({ key: "landing-builder", name: "" }, "acme.com")).toBe("acme.com");
  });

  it("names no domain for an agent whose landing place we do not measure", () => {
    for (const key of ["karos-x-agent-v2", "karos-instagram-agent", "karos-tiktok-agent"]) {
      expect(citationDomainFor({ key, name: "" }, "acme.com"), key).toBeNull();
    }
  });

  it("names no domain for a page agent when the client has no website on file", () => {
    // Absent is not zero: with no domain there is nothing to look up, so the
    // row prints no number rather than "Quoted 0 times".
    expect(citationDomainFor({ key: "karos-blog-writer-v2", name: "" }, null)).toBeNull();
  });
});

describe("the reading order is state first, then the lever", () => {
  it("bands the seven status words, with Not on your plan last", () => {
    expect(visibilityWorkBand({ status: status({ tone: "live", label: "Live" }) })).toBe(0);
    expect(visibilityWorkBand({ status: status({ tone: "progress", label: "Setting up" }) })).toBe(
      1,
    );
    expect(
      visibilityWorkBand({ status: status({ tone: "attention", label: "Setup needs attention" }) }),
    ).toBe(1);
    expect(visibilityWorkBand({ status: status({ label: "Runs on request" }) })).toBe(2);
    expect(visibilityWorkBand({ status: status() })).toBe(3);
    expect(visibilityWorkBand({ status: status({ tone: "disabled", label: "Coming Soon" }) })).toBe(
      4,
    );
    // round 6 review (D4): the last band is the ABSENCE of a roster word — a
    // family this account has no agent for. An ungranted agent that DOES have a
    // roster row is banded by its own state, because it has one.
    expect(visibilityWorkBand({ status: null })).toBe(5);
  });

  it("orders by band, then by the lever's own order, then by name", () => {
    const row = (displayName: string, key: string, over: Partial<RosterStatus> | null) => ({
      displayName,
      status: over === null ? null : status(over),
      lever: visibilityLeverFor({ key, name: displayName })!,
    });
    const ordered = sortVisibilityWorkRows([
      row("Reddit Agent", "karos-reddit-runner", { label: "Runs on request" }),
      row("X Agent", "karos-x-agent-v2", { tone: "live", label: "Live" }),
      row("Blog Agent", "karos-blog-writer-v2", { tone: "live", label: "Live" }),
      // round 6 review (D4): a CATALOGUE row (no roster status) is the one that
      // goes last, not an ungranted agent with a real word.
      row("Reputation Agent", "karos-reputation-runner", null),
      row("LinkedIn Agent", "karos-linkedin-writer-v2", { tone: "live", label: "Live" }),
    ]).map((r) => r.displayName);
    // Live band in lever order (blog before linkedin before X), then the
    // runs-on-request row, then the one this account does not have.
    expect(ordered).toEqual([
      "Blog Agent",
      "LinkedIn Agent",
      "X Agent",
      "Reddit Agent",
      "Reputation Agent",
    ]);
  });
});
