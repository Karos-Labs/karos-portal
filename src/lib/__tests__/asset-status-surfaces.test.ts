import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { postKindLabel } from "@/lib/calendar-kind";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { ClientHomeOverview } from "@/components/client-home-overview";
import {
  CLIENT_ASSET_STATUS_LABEL,
  PUBLISH_HOLD_HEADING,
  STAFF_ASSET_STATUS_LABEL,
  assetStatusLabel,
  clientAssetStatusLabel,
  publishHoldMessage,
} from "@/lib/asset-status-copy";
import { assetTypeLabel } from "@/lib/asset-type-copy";
import { jobStatusLabel } from "@/lib/job-status-copy";
import type { Asset } from "@/lib/types";
import {
  insideAnyRange,
  matchingBrace,
  skipStringLiteral,
  staffOnlyIfRanges,
} from "./source-scan";

/**
 * What the two client-reachable status surfaces print, and what a held post
 * looks like on them.
 *
 * asset-status-registers.test.ts pins the REGISTERS — that two exist and what
 * words they hold. It says nothing about whether a surface asks one, and two did
 * not: the client portal's Recent activity badge rendered `{a.status}` under CSS
 * `capitalize` (so a client read "Published" where their archive said "Posted"),
 * and the detail modal rendered it with no capitalize at all (so a client
 * opening a tile from their own archive read the lowercase Firestore enum).
 *
 * SCOPE. The overview is rendered here and asserted on its real markup. The
 * modal cannot be: it transitively imports server actions, and its shell portals
 * through `createPortal`, so both `renderToStaticMarkup` and the import itself
 * fail. Its wiring is asserted against its SOURCE below, which is what this
 * repo already does for the same reason (asset-visibility.test.ts,
 * publish-error-boundary.test.ts). A source guard proves the lookup is written;
 * that the lookup returns the right word is the register suite's job.
 */

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(join(ROOT, "src", rel), "utf8");

/**
 * Source with comments removed. Every negative below says "the CODE does not do
 * this", and the docstrings explaining why quote the exact strings being
 * forbidden — run against raw text, the honest way to keep them green would be
 * deleting the explanations.
 *
 * STATED HOLE, and it is this strip's rather than the walks' below: `//` is read
 * as a comment opener wherever it appears, INCLUDING inside a string, so a
 * template literal holding a URL loses its closing backtick HERE and reaches a
 * caller as an unpaired one — which `skipStringLiteral` cannot bound to a line
 * (its docstring carries the reasoning and a live example). Two exposures follow,
 * and the shape of each is worth knowing before trusting a green tick: a
 * brace/range walk over a file that writes `//` inside a template can mis-pair
 * that file's literals, while the repo-wide reads below only ask `.includes()`,
 * where a truncated line can hide a match but cannot mis-pair anything. Which
 * files are affected is a question about their source, not about this line, so it
 * is not answered here — the fix is a string-aware strip shared by every copy of
 * this line in this directory, not a local patch.
 */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** JSX props reflow with formatting; a line break is not a behaviour change. */
const flat = (s: string) => s.replace(/\s+/g, " ");

/**
 * `matchingBrace` and `staffOnlyIfRanges` USED TO LIVE HERE, and they moved to
 * ./source-scan for the reason that module exists: a second sweep
 * (status-render-sweep.test.ts) needs the same two questions, and this suite's
 * history is the argument against letting it have its own copy. The `'`/`"`-only
 * string skip that made this file's brace walk mis-pair ranges and report green
 * was one of FOUR copies of one rule. Nothing about the implementations changed in
 * the move; the teeth below now exercise the shared ones, which is the point.
 *
 * `staffOnlyIfRanges` is deliberately the `if (…)` form ONLY. The JSX
 * `{!viewerIsClient && …}` gate is a separate function there, not folded into this
 * one, because widening what counts as a guard would widen every exempted range
 * at every caller — including this file's throw-guard, which must not start
 * reading a JSX conditional as a try block.
 */
const staffOnlyRanges = staffOnlyIfRanges;
const insideStaffOnly = insideAnyRange;

/**
 * The range walk's own teeth, checked here rather than trusted, because it is now
 * load-bearing for two scans (the staff-only sweep and the throw-guard) and its
 * one wrong answer FAILED OPEN — a green tick over a swallowed leak, which is the
 * worst thing a guard can do.
 */
describe("the range walk under an apostrophe", () => {
  /**
   * A staff block whose own prose carries an apostrophe, a leak OUTSIDE it, and a
   * second apostrophe further down. Written as a joined array because what matters
   * is the byte layout: to the SHIPPED skip the `'` in "client's" opens a string
   * that runs to the `'` in "what's", eating the block's closing brace on the way,
   * so the walk settles on the FUNCTION's brace instead and the staff range
   * swallows line 5.
   *
   * TWO loosenings had to be closed for that, and this fixture is honest about
   * needing both: the skip did not know a backtick opens anything (so it walked
   * into template TEXT and read the apostrophe as code), and it let a `'` run past
   * the end of its line (so the bogus string reached line 6). Re-planting either
   * one alone is not enough to make THIS case leak again — the sibling test below
   * pins the line bound on its own, and the chain suite pins backtick-awareness on
   * its own with a `;` inside a label. Verified by planting all three shapes.
   */
  const TRAP = [
    "function build(parts: string[], client: Client, viewerIsClient: boolean) {",
    "  if (!viewerIsClient) {",
    "    parts.push(`- **State:** the client's stored state is ${client.status}`);",
    "  }",
    "  parts.push(`- **Account:** ${client.accountStatus}`);",
    "  parts.push(`what's next`);",
    "}",
  ].join("\n");

  it("ends a staff block at its own brace, so a leak below it stays a leak", () => {
    const ranges = staffOnlyRanges(TRAP);
    expect(ranges.length, "the guard was not recognised at all").toBe(1);

    const guarded = TRAP.indexOf("${client.status}");
    const leak = TRAP.indexOf("${client.accountStatus}");
    expect(guarded).toBeGreaterThan(-1);
    expect(leak).toBeGreaterThan(guarded);

    // Both directions, which is the only way this reads as coverage: what the
    // staff branch really owns is inside…
    expect(insideStaffOnly(ranges, guarded), "the staff block's own line reads as unguarded").toBe(
      true,
    );
    // …and what sits after its closing brace is not. THIS is the assertion the
    // shipped helper failed while reporting green.
    expect(insideStaffOnly(ranges, leak), "a leak below the block reads as guarded").toBe(false);
  });

  it("closes a brace across a template literal, interpolations and all", () => {
    // The interpolation holds CODE, so a naive backtick skip that scans for the
    // next backtick breaks the other way — this pins that `${…}` is brace-matched
    // and that a quote or a nested template inside it cannot unbalance the walk.
    const s = "{ a(`x ${b({ c: \"}\" })} ${`y ${d}`} it's`); }";
    expect(matchingBrace(s, 0)).toBe(s.length - 1);
  });

  it("bounds a stray apostrophe to its own line — the QUOTE half of the contract", () => {
    // JSX text survives comment-stripping, and `<p>Don't</p>` is not a literal. A
    // quote that does not close on its own line is a stray: the walk keeps its
    // place instead of eating to the next apostrophe in the file.
    const jsx = "<p>Don't</p>\n<span>can't</span>";
    const at = jsx.indexOf("'");
    expect(skipStringLiteral(jsx, at)).toBe(at);

    // …but the bound is the LINE, not one character, and this test's name used to
    // say otherwise. Two apostrophes on one line ARE read as a literal — from
    // here that pair is indistinguishable from one — so the words between them
    // are swallowed. What holds is that the range cannot reach the next line, so
    // a brace or a leak below it survives.
    //
    // The first line pins the contract as it stands, so prose and code cannot
    // drift apart again — that is the whole of what this round fixed. Tightening
    // it later (a heuristic reading a letter-hugged apostrophe as never opening)
    // is a change TO that contract, not a violation of it: update the docstring
    // in source-scan.ts and this line together. The second line is the guarantee
    // and holds either way.
    const twoOnALine = "<p>Don't stop, it's here</p>\n<span>ok</span>";
    const stray = twoOnALine.indexOf("'");
    expect(skipStringLiteral(twoOnALine, stray)).toBe(twoOnALine.indexOf("'", stray + 1));
    expect(skipStringLiteral(twoOnALine, stray)).toBeLessThan(twoOnALine.indexOf("\n"));

    // …while a real literal on one line still gets skipped whole.
    const real = "const s = 'it is {';";
    const open = real.indexOf("'");
    expect(skipStringLiteral(real, open)).toBe(real.lastIndexOf("'"));
  });

  it("gives a BACKTICK no line bound, which is required and is not free", () => {
    // The asymmetry, asserted rather than only described, because the test above
    // reads as the whole contract if this one is missing and it is not — the line
    // bound is the quote rule ONLY. Both halves below are the same branch of
    // skipStringLiteral seen from its two sides.
    //
    // REQUIRED: a real template literal spans lines, and `staffOnlyRanges` ends a
    // brace-less statement at a newline. Without this, a guard whose one statement
    // is a multi-line template would be cut off mid-literal.
    const template = ["const t = `line one", "line two`;"].join("\n");
    const opens = template.indexOf("`");
    expect(skipStringLiteral(template, opens)).toBe(template.lastIndexOf("`"));
    expect(skipStringLiteral(template, opens)).toBeGreaterThan(template.indexOf("\n"));

    // THE COST, inseparable from it: an UNPAIRED backtick does not stop at the
    // newline either. It takes the next backtick in the text however far below,
    // so its bogus range is bounded by nothing a caller can see. This is a fact
    // being pinned, not a property being wanted — a stray backtick is what the
    // naive comment strip makes of a template holding a URL, and the reasoning is
    // at skipStringLiteral's STATED HOLE. If a later change contains it, this
    // expectation and that docstring change together.
    const stray = ["const u = `https:", "", "const v = `real`;"].join("\n");
    const at = stray.indexOf("`");
    expect(skipStringLiteral(stray, at)).toBe(stray.indexOf("`", at + 1));
    expect(skipStringLiteral(stray, at)).toBeGreaterThan(stray.indexOf("\n"));

    // …and with no later backtick at all it falls back to "one ordinary
    // character", so the walk still makes forward progress.
    const lone = "const u = `https:\nconst v = 1;";
    expect(skipStringLiteral(lone, lone.indexOf("`"))).toBe(lone.indexOf("`"));
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The REAL clock, deliberately, and this is not a detail: the component reads
 * `Date.now()` to ask whether a row is in the client's 30-day archive window,
 * and drops the ones that are not. A pinned epoch put every fixture years
 * outside that window, so the component rendered "No deliverables yet" and every
 * negative assertion below passed against an empty card — the exact vacuity the
 * `toContain(TITLE)` line in each test now refuses.
 */
const NOW = Date.now();

const TITLE = "Launch teaser";

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    clientId: "client-1",
    title: TITLE,
    content: "Body",
    createdBy: "staff-1",
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 2 * DAY,
    status: "published",
    type: "social_post",
    scheduledAt: NOW - 2 * DAY,
    publishedAt: NOW - 2 * DAY,
    ...overrides,
  };
}

function overview(assets: Asset[], viewerIsClient: boolean): string {
  return renderToStaticMarkup(
    // `clientId` only steers the archive links (a staff reader needs this
    // client's workspace, not the flat one) — nothing this file asserts.
    createElement(ClientHomeOverview, { clientId: "c1", tasks: [], assets, viewerIsClient }),
  );
}

describe("the client portal's Recent activity badge", () => {
  it("prints the client register's word, and no raw status enum", () => {
    const html = overview([asset({ status: "published" })], true);

    // Non-vacuity first. Every assertion under this is about a badge that only
    // exists if the row rendered at all — and this component drops a client's
    // rows that are not in their archive, so a fixture one field out would make
    // the negative below pass for the wrong reason.
    expect(html, "the fixture never reached the row").toContain(TITLE);

    expect(html).toContain(CLIENT_ASSET_STATUS_LABEL.published); // "Posted"
    expect(html, "the stored enum reached the client's screen").not.toContain("published");
  });

  it("prints the staff register's word to staff, off the same fixture", () => {
    // The neighbouring case: "not the enum" must not have been achieved by
    // printing nothing, or by printing the client's word to everyone.
    const html = overview([asset({ status: "published" })], false);

    expect(html).toContain(TITLE);
    expect(html).toContain(STAFF_ASSET_STATUS_LABEL.published); // "Published"
    expect(html).not.toContain(CLIENT_ASSET_STATUS_LABEL.published); // not "Posted"
  });

  it("asks the register even where both registers agree", () => {
    // "Delivered" is the same word in both, so the only thing separating a
    // lookup from the old CSS-capitalised enum is the CASE of what is rendered.
    // This is the case a fix that only special-cased "published" would miss.
    const html = overview([asset({ status: "delivered", publishedAt: undefined })], true);

    expect(html).toContain(TITLE);
    expect(html).toContain(CLIENT_ASSET_STATUS_LABEL.delivered);
    expect(html).not.toContain("delivered");
  });
});

describe("the detail modal's status badge", () => {
  const modal = code(src("components/asset-detail-modal.tsx"));

  it("asks the register with its viewer, and never renders the stored enum", () => {
    expect(flat(modal)).toContain("assetStatusLabel(asset.status, viewerIsClient)");
    // The exact defect: `{asset.status}` interpolated into JSX.
    expect(modal).not.toMatch(/\{\s*asset\.status\s*\}/);
  });

  it("takes its viewer as a required prop, so a new mount cannot omit one", () => {
    // Optional-with-a-default is what let this surface exist un-audited: it
    // would silently pick a register for whichever surface mounted it next.
    // Written without a `?` and without a default, tsc refuses the omission.
    expect(flat(modal)).toContain("viewerIsClient: boolean;");
    expect(flat(modal)).not.toMatch(/viewerIsClient\?:/);
    expect(flat(modal)).not.toMatch(/viewerIsClient\s*=\s*(true|false)/);
  });
});

describe("the one test for 'is this stored string a hold'", () => {
  const HOME = "lib/asset-status-copy.ts";

  it("lives in one file, and nothing else retypes the prefix to ask again", () => {
    // The predicate is the guarantee, so the literal it is built from must not
    // be re-spellable. It is module-private there; this closes the other route,
    // which is copying the words. The FIRST version of this fix left the
    // constant exported and `clientSafePublishError` doing its own startsWith —
    // two spellings, one of which could be reworded without the other noticing,
    // and a disagreement between them is exactly ledger row 48.
    const offenders = walk(join(ROOT, "src"))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => code(readFileSync(f, "utf8")).includes("This post is waiting for"))
      .map((f) => f.slice(join(ROOT, "src").length + 1));

    expect(offenders, "ask isPublishHold instead of retyping the opener").toEqual([HOME]);
  });

  it("keeps the prefix private to that file", () => {
    expect(code(src(HOME))).not.toMatch(/export\s+const\s+PUBLISH_HOLD_PREFIX/);
    expect(code(src(HOME))).toContain("export function isPublishHold");
  });
});

describe("the detail modal's panel over a stored publishError", () => {
  const modal = code(src("components/asset-detail-modal.tsx"));
  const notice = modal.slice(modal.indexOf("function PublishStateNotice"));

  it("tells a hold from a failure by the one shared test", () => {
    // Not by a prefix check spelled again here. The sanitizer, the calendar's
    // classifier and this panel read the same predicate, so they cannot end up
    // calling the same stored string benign in one place and a failure in
    // another — which is the defect, one indirection out.
    expect(notice, "the panel no longer exists as its own function").not.toBe("");
    expect(flat(notice)).toContain("isPublishHold(publishError)");
  });

  it("heads a hold neutrally, and keeps the red heading for a real failure", () => {
    const hold = notice.indexOf("PUBLISH_HOLD_HEADING");
    const failure = notice.indexOf("Publish failed");

    expect(hold, "no hold branch").toBeGreaterThan(-1);
    expect(failure, "no failure branch").toBeGreaterThan(-1);
    // The hold branch returns first, and nothing in it is red. THIS is ledger
    // row 48: "Publish failed" in danger red over a paragraph that plainly says
    // the post is waiting its turn behind an earlier one.
    expect(hold).toBeLessThan(failure);
    expect(notice.slice(0, hold), "the hold panel is styled as a failure").not.toContain("danger");
    // Neighbouring case: the failure branch is still red, so "not red" was not
    // achieved by draining the colour out of both.
    expect(notice.slice(hold, failure)).toContain("danger");
  });
});

/**
 * Every surface that opens the modal, and the viewer it hands over.
 *
 * A required prop makes OMITTING one a compile error; it does not stop a
 * client-reachable surface from hard-coding `false` and printing staff words to
 * a client. So a literal is allowed at exactly one mount, and what makes it true
 * is named rather than assumed — and re-checked below, because an allowlist
 * entry that stops being true would silently permit the next one.
 */
const HARDCODED_VIEWER_MOUNTS = new Map([
  [
    "components/client-agents/outputs-hub.tsx",
    {
      /** Only mounted by the Control Room… */
      via: "components/client-agents/control-room.tsx",
      /** …which the agent detail page mounts behind this gate. */
      gatedIn: "app/(app)/clients/[id]/agents/[agentId]/page.tsx",
      gate: "{isStaff && ( <ControlRoom",
    },
  ],
]);

const MODAL_MOUNT_FILES = [
  "components/archive-view.tsx",
  "components/client-agents/clip-gallery.tsx",
  "components/client-agents/outputs-hub.tsx",
  "components/run-calendar.tsx",
];

describe("every surface that opens the detail modal", () => {
  it("is one of the files this suite checks", () => {
    // The list above is a list, so it can go stale. This is the closed question
    // that keeps it honest: a fifth mount added anywhere in src/ fails HERE
    // rather than escaping the checks below.
    const found = walk(join(ROOT, "src"))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => code(readFileSync(f, "utf8")).includes("<AssetDetailModal"))
      .map((f) => f.slice(join(ROOT, "src").length + 1));

    expect(found.sort()).toEqual([...MODAL_MOUNT_FILES].sort());
  });

  it("hands it a viewer rather than assuming one", () => {
    for (const rel of MODAL_MOUNT_FILES) {
      const mounts = [...flat(code(src(rel))).matchAll(/<AssetDetailModal\b[\s\S]*?\/>/g)].map(
        (m) => m[0],
      );
      expect(mounts.length, `${rel} no longer mounts the modal — drop it from the list`).toBeGreaterThan(0);
      for (const mount of mounts) {
        expect(mount, `${rel} opens the modal with no viewer`).toMatch(/viewerIsClient=/);
        const literal = /viewerIsClient=\{(true|false)\}/.test(mount);
        if (literal) {
          expect(
            HARDCODED_VIEWER_MOUNTS.has(rel),
            `${rel} hard-codes a viewer; thread the surface's own flag or allowlist it with what backs it`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps its one hard-coded viewer backed by a staff-only gate", () => {
    for (const [rel, backing] of HARDCODED_VIEWER_MOUNTS) {
      // Still hard-coded (or the entry is stale and should go)…
      expect(flat(code(src(rel))), `${rel} no longer hard-codes a viewer — drop the entry`).toMatch(
        /viewerIsClient=\{false\}/,
      );
      // …and still reachable only through a staff gate.
      expect(flat(code(src(backing.via)))).toContain("<OutputsHub");
      expect(flat(code(src(backing.gatedIn))), `${backing.gatedIn} no longer gates it on staff`).toContain(
        backing.gate,
      );
    }
  });
});

describe("a held post on the client's dashboard", () => {
  const HOLD = publishHoldMessage(
    { title: "Part 1 of 3", status: "approved" },
    { clientCanSeeBlocker: true },
  );

  /** Due, dated, and carrying the cron's ordering hold. */
  const held = asset({
    status: "scheduled",
    publishedAt: undefined,
    publishError: HOLD,
  });
  /** The same shape, carrying a real failure. */
  const failed = asset({
    status: "scheduled",
    publishedAt: undefined,
    publishError: "Rate limited by LinkedIn",
  });

  it("is not on the attention list, and does not quote the hold as a failure", () => {
    const html = overview([held], true);

    expect(html, "the fixture never reached the list").toContain(TITLE);
    expect(html).not.toContain("failed to publish");
    // The hold sentence was the HINT under that red row: a paragraph explaining
    // nothing is wrong, filed under something being wrong.
    expect(html).not.toContain(HOLD);
    expect(html).toContain("All caught up");
  });

  it("still raises a genuinely failed post, off the same fixture shape", () => {
    // Non-vacuity for the negative above: the row must still exist, or "not on
    // the attention list" would be true because nothing ever is.
    const html = overview([failed], true);

    expect(html).toContain(TITLE);
    expect(html).toContain("1 post failed to publish");
    expect(html).not.toContain("All caught up");
  });
});

describe("the calendar's chip vocabulary", () => {
  const cal = code(src("components/run-calendar.tsx"));

  it("keys the post kind on the shared union rather than re-spelling it", () => {
    // The reason a new kind is a compile error at every map: the union has one
    // home. Spelled out again here, `CalendarPost["kind"]` could quietly fall
    // short of `CalendarAssetKind` and the maps keyed over it would go with it.
    //
    // Scoped to CalendarPost's own body: `CalendarRun.kind` is a genuinely
    // different union ("past" | "scheduled"), and a repo-wide regex would forbid
    // it too.
    const post = cal.slice(cal.indexOf("export interface CalendarPost"));
    const body = post.slice(0, post.indexOf("\n}"));

    expect(flat(body)).toContain("kind: CalendarAssetKind;");
    expect(body).not.toMatch(/kind:\s*"[a-z]+"\s*\|/);
  });

  it("labels and tones the day card off the shared maps, with no fallthrough", () => {
    // The ternary chain this replaced ended `: "Placeholder"`, so the day card
    // called a failed post, a draft and a held post "Placeholder" — while the
    // chip one cell above read "Failed to publish" off the map.
    //
    // Asked as the guarantee, not as a spelling. The first version pinned the
    // literal `POST_KIND_LABEL[post.kind]`, and then failed when the label was
    // made viewer-aware — an improvement it should not have blocked. What matters
    // is that the card derives BOTH label and tone from the shared source and
    // ends in no fallthrough default.
    expect(flat(cal)).toMatch(/const label = postKindLabel\(post\.kind, viewerIsClient\)/);
    expect(flat(cal)).toContain("POST_KIND_TONE[post.kind]");
    // No resurrected fallthrough: the card must not end a chain on a literal.
    expect(flat(cal)).not.toMatch(/:\s*"Placeholder"\s*;/);
  });

  it("draws a held chip neutrally, and keeps the red one for a real failure", () => {
    const chips = cal.slice(cal.indexOf("const POST_CHIP_CLASS"));
    const line = (kind: string) =>
      chips
        .slice(0, chips.indexOf("};"))
        .split("\n")
        .find((l) => l.trim().startsWith(`${kind}:`));

    expect(line("held"), "POST_CHIP_CLASS has no held entry").toBeTruthy();
    expect(line("held")).not.toContain("danger");
    // The neighbouring case — proves the assertion is reading the class map and
    // not an empty string.
    expect(line("failed")).toContain("danger");
  });

  it("names the held post the same way in the chip and the panel", () => {
    // Two names for one state is the defect one indirection out: the client
    // clicks a chip and lands on a different word for what they clicked.
    //
    // Behavioural now, not a source match. The first version asserted the source
    // contained `held: PUBLISH_HOLD_HEADING`, which broke when the label moved to
    // the pure module that owns the kind union — a move that made THIS assertion
    // possible, so the canary was blocking its own improvement.
    for (const viewerIsClient of [true, false]) {
      expect(postKindLabel("held", viewerIsClient)).toBe(PUBLISH_HOLD_HEADING);
    }
    expect(PUBLISH_HOLD_HEADING).not.toMatch(/fail/i);

    // The published kind IS an asset status, so it takes the viewer's register —
    // the chip and the modal it opens must not say two different words. This is
    // the pair that broke when the modal started asking the register: the chip
    // said "Published" and the panel said "Posted".
    expect(postKindLabel("published", true)).toBe(clientAssetStatusLabel("published"));
    expect(postKindLabel("published", false)).toBe(assetStatusLabel("published", false));
    expect(postKindLabel("published", true)).not.toBe(postKindLabel("published", false));

    // Non-status kinds have no register to ask and must stay literal for both.
    for (const kind of ["placeholder", "failed", "held"] as const) {
      expect(postKindLabel(kind, true)).toBe(postKindLabel(kind, false));
    }
  });

  it("lets no surface call a held post a failure, however many readers there are", () => {
    // THE SHAPE, swept repo-wide, because the defect was a COUNT: `publishError`
    // carries two different facts, and every reader that forgets the second one
    // re-creates a heading contradicting its own paragraph. Three readers asked
    // the shared predicate and a FOURTH (asset-card) did not, which no
    // per-surface test could have found — asset-card was not in any of their
    // scopes. Any file that renders the failure wording must also ask.
    // READERS of the stored field, not PRODUCERS of the wording. The first shape
    // of this sweep matched "Publish failed" alone and flagged
    // integrations/publishers.ts, which THROWS that text as an upstream error and
    // never reads `publishError` — a false positive that would have taught the
    // next person to widen the allowlist instead of trusting the guard. A reader
    // is a file that renders the wording AND touches the field.
    const readers = walk(join(ROOT, "src"))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => {
        const src = code(readFileSync(f, "utf8"));
        return src.includes("Publish failed") && src.includes("publishError");
      });
    const offenders = readers
      .filter((f) => !code(readFileSync(f, "utf8")).includes("isPublishHold"))
      .map((f) => f.slice(join(ROOT, "src").length + 1));
    expect(
      offenders,
      "these say 'Publish failed' without asking whether it is a hold",
    ).toEqual([]);

    // Non-vacuity: the sweep found the readers at all, rather than reporting an
    // empty offender list because the walk or the pattern is broken.
    expect(readers.length).toBeGreaterThan(0);
  });

  it("names every kind in the legend map, by shape and not by a list", () => {
    // An array satisfies its element type however short it is, so the legend
    // could name fewer kinds than the grid draws and the filter could not hide
    // what it did not name. A Record over the key type cannot.
    //
    // NAMES, not offers: which of those a given viewer is actually shown is
    // `calendarFilterKeyMatchable`'s answer, derived and pinned in
    // calendar-kind.test.ts. This assertion is about the map being total.
    // `STATUS_FILTER_CHIP_CLASS`, formerly `STATUS_FILTER_CHIPS`: the map kept its
    // Record-over-the-union shape and lost its `label` half, which moved to
    // `calendarFilterLabel` (lib/calendar-kind) after `review` was found inventing
    // "Pending review" for a JobStatus the run card below the legend calls "In
    // review". The words' own totality is asserted where they now live —
    // status-render-sweep.test.ts asks the accessor for every key — so this line is
    // only about the swatches still being total.
    expect(flat(cal)).toContain("STATUS_FILTER_CHIP_CLASS: Record<CalendarFilterKey");
    // …and the render site asks the per-viewer rule rather than painting the map
    // whole, which is the half a total map cannot give you.
    expect(flat(cal)).toContain("calendarFilterKeyMatchable(key, viewerIsClient)");
  });
});

/**
 * The copilot's own status vocabulary.
 *
 * The dock is a client-reachable status surface like any other, and the one with
 * no render to gate: `find_output` composes TOOL TEXT that a model paraphrases
 * back into the conversation, so an interpolated `asset.status` reaches a client
 * as prose in whatever wording the model picks. Ledger row 51 closed the two
 * rendered badges; this is the same question asked of the surface that has no
 * badge.
 *
 * SCOPE, and it is the same one this file already states for the detail modal:
 * the tool's `execute` is a closure inside the route handler and is not
 * exported, so the wiring is asserted against the route's SOURCE. That the
 * lookup returns the right word for each viewer is the register suite's job.
 *
 * The describe is named for find_output, and the interpolation half below is
 * scoped to its slice — but the half that matters, "is a status read as a value
 * anywhere", is asked over the WHOLE route, because a status extracted in one
 * closure can be interpolated in another.
 */
describe("the copilot's find_output tool text", () => {
  const route = code(src("app/api/clients/[id]/chat/route.ts"));
  const tools = route.slice(route.indexOf("const findOutputTool"), route.indexOf("const runAgentNowTool"));

  /**
   * The route's local status accessor, DISCOVERED rather than pinned: whatever
   * local name is bound to a call of the shared `assetStatusLabel`.
   *
   * Discovering it is what lets the negative below be strict about the callee
   * while still allowing the helper to be renamed — the property the previous
   * shape-only version bought by being too weak to notice `String(asset.status)`.
   */
  const accessor = /const (\w+) = \([^)]*\)[^=]*=>\s*assetStatusLabel\(/.exec(route)?.[1] ?? "";

  /**
   * The two callees that turn a stored status into a reader's word: the local
   * accessor above, and the shared register lookup it wraps. Both are legitimate
   * here — calling the shared one with a hard-coded viewer is what the NEXT test
   * forbids, so this one does not also try to.
   */
  const REGISTER_CALLEES = [accessor, "assetStatusLabel"].filter(Boolean);
  /**
   * The read is the accessor's ARGUMENT: the nearest still-open call before it is
   * a register call. `[^()]*` is what makes "nearest still-open" the question —
   * it cannot cross another call's parenthesis, so `String(asset.status)` and
   * `${label(fmt(a.status))}` are both outside it even with a register call
   * earlier on the line. That strictness is not pedantry: the register falls back
   * to the STORED value for a word it does not know, so a status laundered through
   * some other call first comes back out raw.
   *
   * The cost is that a receiver containing a call —
   * `${accessor(matches.find(p)!.status)}` — reads as unconsumed and fails. The
   * remedy is to bind the record first, which is what the live code already does.
   */
  const CONSUMED_BY_REGISTER = new RegExp(`\\b(?:${REGISTER_CALLEES.join("|")})\\(\\s*[^()]*$`);
  const USED_AS_PREDICATE = /^\s*(?:===|!==|==|!=)/;

  /**
   * Every READ of a stored status: `.status`, and `.jobStatus` because field names
   * are SUFFIXED in this codebase, the bracket form `asset["status"]`, and the
   * DESTRUCTURED form, which has no dot at all.
   *
   * The RECEIVER is deliberately not part of the pattern. Anchoring on an
   * identifier (`a.status`) would have missed `matches[0]!.status` and
   * `promptAssets.find(…)!.status` — a receiver ending in `]`, `)` or `!` is still
   * a receiver, and the first draft of this scan walked into exactly that hole
   * while probing itself.
   *
   * The bracket form takes a LOWERCASE receiver only: a capitalised one is a TYPE
   * (`Asset["status"]` is the accessor's own parameter annotation), and the
   * lookbehind stops the pattern matching the tail of one.
   *
   * ALL THREE DELIMITERS, matched as a pair through a backreference. This class
   * used to read `["']`, so `` asset[`status`] `` — a computed member read with a
   * template literal, ordinary JS — was invisible to it: planted into the live
   * find_output body with both sanitized register calls left in place, the suite
   * was GREEN. That is the SAME quotes-only loosening the shared string skip in
   * `source-scan.ts` was hardened against, surviving inside the function the
   * hardening was for, and it is the fail-OPEN direction: a leak the scan cannot
   * see reads as no leak at all.
   *
   * DESTRUCTURING is the shape that walked straight through the first version of
   * this inverted rule, which is the exact class the inversion existed to close:
   * `const { status } = asset;` then `${status}` was GREEN with both sanitized
   * register calls left in place, and so was the aliased
   * `const { status: rawState } = asset;` then `${rawState}`. The read is anchored
   * on the KEY — the stored field being taken — not on the local it lands in, so
   * the alias is covered by the same match and the local may be called anything.
   * Brace-matched rather than `\{[^{}]*\}`, so a nested pattern
   * (`const { asset: { status } } = row`) is seen too.
   *
   * STATED HOLE, with its reason: a destructured PARAMETER (`(({ status }) => …)`)
   * is not covered, because no regex can tell one from an argument OBJECT LITERAL
   * in the same position — this route really calls
   * `listClientAgentFeedback({ clientAgentId, status: "active" })`, and flagging a
   * query field as a leak is the false positive that gets a guard deleted. A
   * declaration is decidable; a parameter is not, so only the decidable one is
   * swept, and the sweep at the SINK below is the second net under it.
   */
  function statusReads(s: string): Array<{ text: string; start: number; end: number }> {
    const out: Array<{ text: string; start: number; end: number }> = [];
    const add = (m: RegExpMatchArray) =>
      out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length });
    for (const m of s.matchAll(/\.\w*[Ss]tatus\b/g)) add(m);
    for (const m of s.matchAll(/(?<![\w$.])[a-z_$][\w$]*\[\s*(["'`])\w*[Ss]tatus\1\s*\]/g)) add(m);
    for (const decl of s.matchAll(/\b(?:const|let|var)\s+(?=\{)/g)) {
      const open = decl.index! + decl[0].length;
      const close = matchingBrace(s, open);
      if (close < 0) continue;
      const pattern = s.slice(open, close + 1);
      for (const key of pattern.matchAll(/(?:^|[{,])\s*(\w*[Ss]tatus)\s*(?=[,:}=])/g)) {
        const at = open + key.index! + key[0].indexOf(key[1]!);
        out.push({ text: `{ ${key[1]!} }`, start: at, end: at + key[1]!.length });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  it("sees a status taken by destructuring, plain and aliased", () => {
    // The scan's own teeth for BLOCKING 3, kept here rather than proved by a plant
    // once and forgotten. A destructured binding has no dot, so the member-read
    // patterns could not see it — and that is the exact class the rule was inverted
    // to close: an ADDITIVE leak through a differently-named local, with both
    // sanitized register calls left untouched. Planted into the live route in both
    // spellings, it was GREEN.
    const read = (s: string) => statusReads(s).map((r) => r.text);

    expect(read("const { status } = asset;")).toContain("{ status }");
    // Aliased: anchored on the KEY, which is the stored field being taken, so the
    // local may be called anything at all.
    expect(read("const { status: rawState } = asset;")).toContain("{ status }");
    // Suffixed field names, the convention this codebase actually uses.
    expect(read("const { jobStatus, id } = run;")).toContain("{ jobStatus }");
    // Nested, which `\{[^{}]*\}` could not reach — this is why the pattern is
    // brace-matched through the shared walk.
    expect(read("const { job: { status } } = row;")).toContain("{ status }");
    // A default value is still a read.
    expect(read('const { status = "draft" } = asset;')).toContain("{ status }");

    // BOUNDARY, so the scan stays green on legitimate code: an argument object
    // LITERAL with a status field is not a read of a stored status, and the live
    // route really writes one.
    expect(read('listClientAgentFeedback({ clientAgentId: u.id, status: "active" })')).toEqual([]);
    expect(read('return Response.json({ error: "Forbidden" }, { status: 403 });')).toEqual([]);
    // And a destructuring with nothing status-shaped in it stays silent.
    expect(read("const { id: clientId } = await params;")).toEqual([]);
  });

  it("sees a computed read in any of the three quote forms, and only a real one", () => {
    // The scan's own teeth for the bracket alternative, which shipped as `["']`
    // and so could not see `` asset[`status`] `` — valid JS, and GREEN when
    // planted into the live find_output body with both register calls intact.
    // Verified in both directions by that plant: red with it, and the whole suite
    // green with the route restored byte-for-byte.
    const read = (s: string) => statusReads(s).map((r) => r.text);

    for (const q of ['"', "'", "`"]) {
      expect(read(`asset[${q}status${q}]`), `the ${q} form is invisible`).toContain(
        `asset[${q}status${q}]`,
      );
    }
    // Suffixed field names, matched in the bracket form too.
    expect(read("run[`jobStatus`]")).toContain("run[`jobStatus`]");

    // BOUNDARIES, so this stayed green on legitimate code rather than only
    // getting stricter. A capitalised receiver is a TYPE, not a read — the
    // accessor's own `Asset["status"]` annotation is the live example…
    expect(read('const f = (status: Asset["status"]) => label(status);')).toEqual([]);
    // …the two delimiters must be the SAME one, which is what the backreference
    // buys over a second character class…
    expect(read('asset[`status"]')).toEqual([]);
    // …and a key ASSEMBLED inside the brackets is not matched, because the pattern
    // wants `status`-shaped text between the two delimiters and `${prefix}Status`
    // is not that.
    //
    // STATED HOLE, not a boundary, and the difference matters: this is NOT the
    // claim that a computed key names no stored field. With `prefix = "job"` it
    // names `jobStatus`, which this codebase really stores — what is true is that
    // no regex can decide which field a key assembled at runtime names. Same
    // family as the destructured PARAMETER above, with one thing worse: the sink
    // sweep is no second net here, because it asks `statusReads` of each
    // interpolation and so cannot see this shape either. If a computed status key
    // ever appears in this route, it has to be met by naming the field.
    expect(read("row[`${prefix}Status`]")).toEqual([]);
  });

  it("found the tool bodies it is asserting about", () => {
    // Without this every negative below would pass vacuously on "" after a
    // rename.
    expect(tools).not.toBe("");
    expect(tools).toContain("status:");
    // The single-match answer, so the slice reaches PAST the disambiguation list
    // to the branch that composes one asset's own line. A VACUITY ANCHOR: what it
    // has to buy is "the scan sees this region". As `toContain("id: ${asset.id}")`
    // it pinned byte-exact bytes, so reformatting the live source to
    // `${ asset.id }` reddened it while the sweep it vouches for stayed green —
    // the source-canary trap this campaign keeps removing, sitting inside the
    // suite doing the removing.
    //
    // It is not spelling-free, and cannot be: an anchor has to name something it
    // expects to find, so this one still pins the receiver `asset` and the key
    // `id` — what the regex drops is the FORMATTING around them, nothing more.
    // Worth saying out loud because the sweeps it vouches for deliberately do NOT
    // name a receiver (see `statusReads`), so this line is the one place in the
    // describe where renaming `asset` in the live route goes red while every
    // actual guard stays green. When that happens the anchor is what needs
    // re-reading — re-point it at the renamed receiver, do not loosen it into
    // something that would also match an empty region.
    expect(tools).toMatch(/id:\s*\$\{\s*asset\.id\s*\}/);
    // And it found the accessor, so the negative below is comparing against a
    // real identifier rather than the empty string.
    expect(accessor).not.toBe("");
  });

  it("lets no stored status escape as a value, so none can reach the model as prose", () => {
    // THE loosening, and the exact shape that shipped: `(${a.status})` in the
    // disambiguation list and `status: ${asset.status}` in the single-match
    // answer. Absent from the payload beats unrendered — there is no render here
    // to gate, and no wording the model could be trusted to fix.
    //
    // ASKED AT THE SOURCE, over the whole route. Every earlier version asked at
    // the SINK, about interpolations SPELLED with `.status`, and an ADDITIVE
    // loosening walked past all of them with both sanitized calls left in place:
    //
    //   const rawState = asset.status;
    //   … `- "${a.title}" (${rawState}) — id: ${a.id}`
    //
    // Recognising a bare local named after the field — the sibling sweep's answer
    // one describe down — cannot help here, because `rawState` is not named after
    // anything. So the question is inverted into the closed one: every place a
    // stored status is READ, is it handed to a register accessor, or used as a
    // predicate? Those are the only two things that can be done with a status in
    // this file, and every OTHER use — a binding, `String(…)`, a method call —
    // yields a value that can be interpolated later under any name at all.
    //
    // FAILS CLOSED, and deliberately: a legitimate non-text use that arrives
    // later (sorting or grouping by status, say) will fail here, and the fix is to
    // widen this list of safe consumptions with the reason — not to go back to
    // asking about spellings.
    const escaped = statusReads(route)
      .filter((r) => !CONSUMED_BY_REGISTER.test(route.slice(0, r.start)))
      .filter((r) => !USED_AS_PREDICATE.test(route.slice(r.end)))
      .map((r) => `${r.text} @ …${flat(route.slice(Math.max(0, r.start - 44), r.start)).trim()}`);
    expect(
      escaped,
      `these read a stored status as a value; hand it to ${accessor}() or compare it`,
    ).toEqual([]);
    // Non-vacuity: the scan finds the real reads rather than reporting an empty
    // list because the pattern or the file slice broke, and some of them are
    // being labelled (so "nothing escaped" is not "nothing is read").
    const labelledReads = statusReads(route).filter((r) =>
      CONSUMED_BY_REGISTER.test(route.slice(0, r.start)),
    );
    expect(labelledReads.length, "no status is handed to a register at all").toBeGreaterThanOrEqual(2);
    expect(statusReads(route).length).toBeGreaterThan(labelledReads.length);

    // AND AT THE SINK, over EVERY interpolation in the tool bodies rather than
    // only the ones that mention a status: each is either a register call or an
    // expression with no status in it. Two halves of one question, because a
    // status can also arrive already extracted — `${String(asset.status)}` is a
    // call, which is why the "passes through some call" version accepted it, and a
    // wholesale record dump carries every field the record has including this one.
    //
    // THE SANCTIONED SHAPE: the whole interpolation is one register call. Its
    // first argument is `[^(),]*` rather than an identifier path — a receiver can
    // be `matches[0]!.status` or `asset["status"]` — and the optional second is
    // the viewer flag the SHARED lookup takes, because calling that one inline is
    // legitimate and the first draft of this pattern flagged it (a guard that
    // fires on correct code gets deleted). Neither argument may contain a paren,
    // so no nested call hides inside, and the interpolation must END at the close
    // paren, so `${label(x) + a.status}` is not one of these.
    const LABELLED = new RegExp(
      `^\\$\\{\\s*(?:${REGISTER_CALLEES.join("|")})\\(\\s*[^(),]*(?:,\\s*[^()]*)?\\)\\s*\\}$`,
    );
    const interpolations = tools.match(/\$\{[^{}]*\}/g) ?? [];
    const labelled = interpolations.filter((i) => LABELLED.test(i));
    const unaccounted = interpolations.filter(
      (i) => !LABELLED.test(i) && (statusReads(i).length > 0 || i.includes("JSON.stringify(")),
    );
    expect(
      unaccounted,
      `these hand the model something that can carry a stored status; call ${accessor}() on the field you mean`,
    ).toEqual([]);
    // Non-vacuity for the accounting: the slice has interpolations to classify,
    // and the two answers still tell the model a labelled state.
    expect(labelled.length, "find_output stopped labelling any status").toBeGreaterThanOrEqual(2);
    expect(interpolations.length).toBeGreaterThan(labelled.length);
  });

  it("asks the register with the actor's viewer, never a constant", () => {
    // A client session composing staff words would be the same defect wearing a
    // fix: this route serves both docks, so the viewer is the one thing it
    // cannot hard-code.
    expect(flat(route)).not.toMatch(/assetStatusLabel\([^)]*\b(?:true|false)\s*\)/);
    // …and the flag is DERIVED from the predicate the deep links already use
    // rather than answered a second way, which is what keeps one session from
    // being staff for one answer and a client for the other. The predicate is
    // pinned (it is a shared export); the local name it is bound to is not.
    expect(flat(route)).toMatch(/const \w+ = !isStaffCopilotActor\(user\)/);
  });

  it("would say a different word to each actor, so the lookup is not decorative", () => {
    // Non-vacuity for the source guards above: the register actually changes the
    // words the two answers carry, and neither is the stored enum.
    for (const status of ["draft", "scheduled"] as const) {
      expect(assetStatusLabel(status, true)).not.toBe(status);
      expect(assetStatusLabel(status, false)).not.toBe(status);
    }
    expect(assetStatusLabel("draft", true)).not.toBe(assetStatusLabel("draft", false));
  });
});

/**
 * The other half of "what the model is handed": the SYSTEM PROMPT.
 *
 * The describe above is named for its region now, because it only ever checked
 * one — the slice between `findOutputTool` and `runAgentNowTool`. Its old name
 * ("into what the model is handed") promised the whole payload, and while it
 * watched `find_output`, `buildCopilotSystemPrompt` was interpolating three raw
 * enums into the system string itself: `client.status` ("paused"), `job.status`
 * ("review") and `asset.type` ("instagram_post"). A system prompt is payload in
 * exactly the same sense a tool result is — the model reads it and paraphrases
 * it — so "what's my account status?" could be answered with a database word.
 *
 * Same doctrine, one indirection further out: sanitize at the boundary, and let
 * the broad claim be made by the assertion rather than by the test name.
 */
describe("the copilot system prompt", () => {
  // EVERY part the route concatenates, not just the one this test was written
  // against. The route builds the system string as
  //   baseSystemPrompt + buildProactiveSystemAppendix(…) + creditsAppendix +
  //   agentFeedbackAppendix + focusAppendix + nowAppendix
  // and the first version of this sweep read only copilot-context.ts — while
  // criticising the test above it for promising the whole payload and checking one
  // region. It repeated the defect it named, and a live leak was sitting in an
  // unread part: proactive-assistant.ts interpolated a raw `assetType` into the
  // benchmarks block. Composed here so a NEW part added to the concatenation is a
  // visible omission rather than a silent one.
  const PROMPT_PARTS = [
    "lib/copilot-context.ts",
    "lib/ai/prompts/proactive-assistant.ts",
  ];
  const prompt = PROMPT_PARTS.map((rel) => code(src(rel))).join("\n");

  it("found the builder it is asserting about", () => {
    expect(prompt).not.toBe("");
    expect(prompt).toContain("export function buildCopilotSystemPrompt");
    expect(prompt).toContain("## CLIENT PROFILE");
  });

  it("interpolates no raw enum into a CLIENT's system string", () => {
    // The three that shipped, as the shape rather than the three spellings: any
    // `${…}` reaching for one of these enum-valued fields is a database word in
    // prose the model will repeat.
    //
    // The rule is about the CLIENT's payload, so a raw enum is allowed on a line
    // the staff branch owns — staff are owed the stored value, and laundering it
    // for them would change an operator's words to fix a client's problem. Every
    // raw enum must therefore sit behind `!viewerIsClient`.
    //
    // BLOCK-AWARE, and it had to become so: the scan's granularity used to be one
    // LINE, so it recognised only the single-line `if (!viewerIsClient)
    // parts.push(…)` form the builder happens to use, and a multi-line staff-only
    // block would have read as unguarded — a TRUE failure that looks false, which
    // is the kind that gets a guard loosened instead of a leak fixed.
    //
    // "Which guard is nearest above this line" is NOT the question, for exactly the
    // reason the throw-guard below had to be rewritten: a guard that has already
    // closed is not a guard. The question is whether the interpolation sits inside a
    // range a staff guard still governs, so each guard's range is what gets
    // computed — its braced block, or the one statement that follows it.
    //
    // It FAILS CLOSED on any other guard shape (a `viewerIsClient ? … : …`
    // ternary, an `else` branch): those read as unguarded and get flagged. That is
    // the safe direction — a spurious flag with a message saying what to do, not a
    // leak — and the remedy is to write the recognised shape or extend this scan.
    //
    // THAT DIRECTION IS ONLY TRUE WHILE THE RANGE WALK IS, and it was not. The
    // claim above says an unrecognised guard over-flags; it says nothing about a
    // recognised guard whose range is computed too WIDE, which is the fail-OPEN
    // direction and is what shipped. `matchingBrace` skipped `'` and `"` and not
    // backticks, so an apostrophe in a staff block's own prose ("the client's
    // stored state") opened a bogus string that ran past the block's closing brace
    // to the next apostrophe — and an unguarded `${client.accountStatus}` in
    // between read as INSIDE the staff range. Planted exactly that: the leak was
    // swallowed and this suite stayed green. So the guarantee is stated in two
    // halves now, and the second is the one a helper has to earn: an unrecognised
    // guard shape over-flags, AND a recognised guard's range ends where its brace
    // does, because every string literal — backticks included — is skipped whole
    // by the one shared primitive whose own teeth are checked below.
    //
    // SECOND STATED HOLE: this recognises an enum by its field access or by a local
    // named after the field. A value rebound to a differently-named local
    // (`const s = a.status; …${s}`) escapes it, and no regex over source text is
    // going to fix that. The per-field pins in the next test are the real guard for
    // the three sites that exist; this sweep is the guard against a NEW one.
    // TWO shapes, because the field-access shape alone has a hole this probe found
    // by walking into it. Reverting `assetTypeLabel(type)` to `${type}` left the
    // sweep GREEN: the asset type arrives via `Object.entries(byType)`, so by the
    // time it is interpolated it is a BARE LOCAL named `type` and there is no
    // `.type` for a field pattern to see. A shape test that cannot see a realistic
    // loosening is decoration, so a bare local named after one of the enum fields
    // counts as the enum — which is the naming convention this file actually uses.
    // Field names are SUFFIXED in this codebase — `assetType`, `jobStatus` — so a
    // pattern anchored on `.status`/`.type` exactly cannot see them. That is not
    // hypothetical: it is why the live `${b.assetType}` leak in the benchmarks
    // block survived a sweep written to catch exactly that shape. Matching the
    // suffix is what makes the question "is any stored status/type field
    // interpolated raw", rather than "is one of two spellings".
    const FREE_TEXT_FIELDS = ["businessType"];
    const RAW_FIELD = /\.\w*(?:[Ss]tatus|[Tt]ype)\b/;
    const RAW_LOCAL = /^\$\{\s*\w*(?:[Ss]tatus|[Tt]ype)\s*\}$/;
    // NAMED callees only, discovered from the label modules rather than accepted
    // as "any call". The first version was /\w+\(…\)/, which accepted ANY callee —
    // so `${String(first.type)}` put the enum straight back into the text a client's
    // model reads and the sweep stayed green, while the comment beside it claimed
    // to verify a register. That is the exact loosening this round was told to
    // close in find_output, reproduced one test down.
    const LABEL_CALLEES = [
      ...new Set(
        [
          readFileSync(join(ROOT, "src", "lib", "asset-status-copy.ts"), "utf8"),
          readFileSync(join(ROOT, "src", "lib", "asset-type-copy.ts"), "utf8"),
          readFileSync(join(ROOT, "src", "lib", "job-status-copy.ts"), "utf8"),
        ]
          .flatMap((src) => [...src.matchAll(/export function (\w*[Ll]abel\w*)/g)])
          .map((m) => m[1]!),
      ),
    ];
    // Non-vacuity on the allowlist itself: an empty list would make every call
    // an offender, which reads as a passing sweep only by accident.
    expect(LABEL_CALLEES.length, "found no label accessors to allow").toBeGreaterThan(2);
    const THROUGH_A_CALL = new RegExp(
      `\\b(?:${LABEL_CALLEES.join("|")})\\(\\s*[A-Za-z_$][\\w$.]*\\s*\\)`,
    );
    const staffOnly = staffOnlyRanges(prompt);
    const offenders: string[] = [];
    for (const m of prompt.matchAll(/\$\{[^{}]*\}/g)) {
      const interp = m[0];
      if (!RAW_FIELD.test(interp) && !RAW_LOCAL.test(interp)) continue;
      // FREE TEXT that merely ends in Type/Status. The pattern above matches a
      // field-name SHAPE, and shape cannot tell a closed union from prose — so
      // the default is to flag, and a genuinely free-text field is allowlisted
      // here WITH its reason. `ClientReport.businessType` is `string`, written
      // from the report's company profile ("SaaS", "Fintech"): the client's own
      // description of their own business, with no union behind it and nothing
      // internal to launder. Adding to this list should feel like a decision.
      if (FREE_TEXT_FIELDS.some((f) => interp.includes(f))) continue;
      // Through one of the label accessors discovered above — not any call.
      if (THROUGH_A_CALL.test(interp)) continue;
      // Or inside a range the staff branch owns — block or single statement.
      if (insideStaffOnly(staffOnly, m.index!)) continue;
      offenders.push(interp);
    }
    // Non-vacuity for the guard half: the scan found a staff-only range at all
    // (an empty list would make "guarded" unreachable and every staff line an
    // offender), and the one live guard is a single-statement one, so a green run
    // is not evidence that the block path works — the plants are.
    expect(staffOnly.length, "found no staff-only guard to recognise").toBeGreaterThan(0);
    expect(
      offenders,
      "these hand a CLIENT's model a stored enum; ask a register, or drop the field for a client",
    ).toEqual([]);
    // Non-vacuity: the scan does see this file's interpolations at all, and it
    // does see the guarded one (so "no offenders" is not "found nothing").
    //
    // Whitespace-tolerant, like its sibling below and for the same reason: as
    // `toContain("${client.status}")` this pinned ONE byte-exact spelling, so
    // reformatting to `${ client.status }` — still guarded, still correct — failed
    // here while the sweep it is vouching for passed. A residual source canary is
    // the defect this round already fixed once, four lines down.
    expect((prompt.match(/\$\{[^{}]*\}/g) ?? []).length).toBeGreaterThan(10);
    expect(prompt).toMatch(/\$\{\s*client\.status\s*\}/);
  });

  it("wraps every action a client's tool awaits, so a throw cannot reach their model", () => {
    // A RETURNED refusal is client copy and passes through verbatim — those are
    // written for this reader. A THROW is not: `requireAssetAccess` opens with
    // `throw new Error("Unauthorized")` / "Asset not found" / "Forbidden", and the
    // AI SDK hands an uncaught throw straight to the model, which paraphrases it.
    //
    // The comment that shipped here certified the client path as safe on the
    // grounds that every refusal is composed as client copy. True, and not the
    // whole story — which is why this asks the SHAPE rather than trusting prose:
    // any `await client*Action(` inside a tool must sit under a try.
    const route = code(src("app/api/clients/[id]/chat/route.ts"));
    const calls = [...route.matchAll(/await\s+(client[A-Z]\w*Action)\s*\(/g)];
    // Non-vacuity: there is at least one such call to be wrong about.
    expect(calls.length, "found no client action calls to check").toBeGreaterThan(0);

    // BRACE-AWARE, because "the nearest try before the call" is not the question.
    // The first version asked that, and it passed with the guard deleted: the staff
    // branch directly above has its own try/catch, so a SIBLING try that had
    // already closed satisfied it. What has to be true is that the call sits
    // lexically inside a try block that is still OPEN at that point.
    const enclosedByTry = (at: number): boolean =>
      [...route.matchAll(/try\s*\{/g)]
        .map((t) => t.index! + t[0].length - 1)
        .filter((open) => open < at)
        .some((open) => matchingBrace(route, open) > at);

    for (const call of calls) {
      expect(
        enclosedByTry(call.index!),
        `${call[1]} is awaited outside any try — an uncaught throw reaches the client's model`,
      ).toBe(true);
    }
  });

  it("routes each of the three through the answer chosen for it", () => {
    // Not one blanket fix — each field got the answer its own domain called for,
    // and this pins which, because "we labelled them all" would hide that
    // `client.status` has no client-facing register and should not be there.
    //
    // client.status: DROPPED for a client. Account lifecycle
    // ("active"/"paused"/"archived") is not the client's reading, and there is no
    // register to launder it through — so unlike the other two it must be behind
    // the staff guard, not behind a label call.
    //
    // ASKED AS THE GUARANTEE, not as the spelling. This pinned the exact line
    // `if (!viewerIsClient) parts.push(`- **Status:** ${client.status}`)` — a source
    // canary, and it fired on the correct code the moment the guard became a
    // multi-line staff block, which is the very shape the sweep above was extended
    // to understand. It was blocking its own improvement; a probe that planted the
    // block watched the sweep pass and THIS line fail.
    const clientStatusInterps = [...prompt.matchAll(/\$\{\s*client\.status\s*\}/g)];
    expect(
      clientStatusInterps.length,
      "the prompt no longer gives staff the stored account status at all",
    ).toBeGreaterThan(0);
    const promptStaffOnly = staffOnlyRanges(prompt);
    for (const m of clientStatusInterps) {
      expect(
        insideStaffOnly(promptStaffOnly, m.index!),
        "client.status is composed outside any staff-only guard",
      ).toBe(true);
    }
    // …and it is DROPPED rather than relabelled: no register accessor is reaching
    // for it, which is what would hide the "there is no client register for this
    // field" decision behind a laundering call.
    expect(prompt).not.toMatch(/\w*[Ll]abel\w*\(\s*client\.status/);
    // job.status: RELABELLED through the register the run badges already read.
    // Whitespace-tolerant, and the receiver is not pinned either: which local the
    // job is bound to (`j`) is the loop's business, and reformatting the call is
    // not a behaviour change. What has to hold is that the field goes through that
    // register.
    expect(prompt).toMatch(/jobStatusLabel\(\s*\w+\.status\s*\)/);
    expect(prompt).toContain('from "@/lib/job-status-copy"');
    // asset.type: RELABELLED through the register the deliverable cards read. The
    // argument is a bare local because the type arrives via `Object.entries`, so
    // the callee is what this pins.
    expect(prompt).toMatch(/assetTypeLabel\(\s*\w+\s*\)/);
    expect(prompt).toContain('from "@/lib/asset-type-copy"');
  });

  it("defaults to the client's vocabulary when a caller forgets to say", () => {
    // Fail SAFE. A new caller that omits the flag must withhold internal
    // vocabulary, not leak it — the opposite default would make the next surface
    // to build a prompt leak by silence.
    expect(prompt).toMatch(/const viewerIsClient = opts\.viewerIsClient !== false/);
  });

  it("would say a different word than the enum, so the lookups are not decorative", () => {
    // Behavioural non-vacuity for the source guards above: the two registers the
    // prompt now asks actually change the words.
    expect(jobStatusLabel("review")).toBe("In review");
    expect(jobStatusLabel("review")).not.toBe("review");
    expect(assetTypeLabel("instagram_post")).toBe("Instagram post");
    expect(assetTypeLabel("instagram_post")).not.toBe("instagram_post");
  });
});
