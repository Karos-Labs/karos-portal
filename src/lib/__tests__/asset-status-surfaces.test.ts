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
 */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** JSX props reflow with formatting; a line break is not a behaviour change. */
const flat = (s: string) => s.replace(/\s+/g, " ");

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
    createElement(ClientHomeOverview, { tasks: [], assets, viewerIsClient }),
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
    expect(flat(cal)).toContain("STATUS_FILTER_CHIPS: Record<CalendarFilterKey");
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

  it("found the tool bodies it is asserting about", () => {
    // Without this every negative below would pass vacuously on "" after a
    // rename.
    expect(tools).not.toBe("");
    expect(tools).toContain("status:");
    expect(tools).toContain("id: ${asset.id}");
    // And it found the accessor, so the negative below is comparing against a
    // real identifier rather than the empty string.
    expect(accessor).not.toBe("");
  });

  it("interpolates no raw status enum into what find_output hands the model", () => {
    // THE loosening, and the exact shape that shipped: `(${a.status})` in the
    // disambiguation list and `status: ${asset.status}` in the single-match
    // answer. Absent from the payload beats unrendered — there is no render here
    // to gate, and no wording the model could be trusted to fix.
    //
    // ASKED OVER EVERY INTERPOLATION, not against one bad spelling. The earlier
    // version matched only `${x.status}` and "passes through some call", and a
    // realistic loosening walked straight through both: `status:
    // ${String(asset.status)}` satisfies the shape (`String` is an identifier and
    // `.status` is its argument) while putting the raw enum back in the payload.
    // So the rule is inverted — every `${…}` that mentions `.status` must be a
    // call to THIS route's discovered accessor, and any other callee, `String`
    // and `` `${a.status}` `` alike, is a failure.
    const interpolations = tools.match(/\$\{[^{}]*\}/g) ?? [];
    const touchingStatus = interpolations.filter((i) => /\.status\b/.test(i));
    const throughTheAccessor = new RegExp(
      `^\\$\\{\\s*${accessor}\\(\\s*[A-Za-z_$][\\w$]*\\.status\\s*\\)\\s*\\}$`,
    );
    const offenders = touchingStatus.filter((i) => !throughTheAccessor.test(i));
    expect(
      offenders,
      `these put a raw status into the model's payload; call ${accessor}() instead`,
    ).toEqual([]);
    // Non-vacuity, twice over: there ARE status interpolations here (so the filter
    // is not reporting an empty list because the slice or the pattern broke), and
    // both of the two sites are still present.
    expect(touchingStatus).toHaveLength(2);
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
    // SCOPE, because this scan's granularity is one LINE: it recognises the
    // single-line `if (!viewerIsClient) parts.push(…)` form the builder uses. A
    // multi-line staff-only block would read as unguarded here and would need the
    // scan extended rather than the guard assumed. Stated so the next person does
    // not discover it by watching a true failure look false.
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
    const lines = prompt.split("\n");
    const offenders: string[] = [];
    for (const line of lines) {
      for (const interp of line.match(/\$\{[^{}]*\}/g) ?? []) {
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
        // Or on a line the staff branch owns.
        if (line.includes("!viewerIsClient")) continue;
        offenders.push(interp);
      }
    }
    expect(
      offenders,
      "these hand a CLIENT's model a stored enum; ask a register, or drop the field for a client",
    ).toEqual([]);
    // Non-vacuity: the scan does see this file's interpolations at all, and it
    // does see the guarded one (so "no offenders" is not "found nothing").
    expect((prompt.match(/\$\{[^{}]*\}/g) ?? []).length).toBeGreaterThan(10);
    expect(prompt).toContain("${client.status}");
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
    const enclosedByTry = (at: number): boolean => {
      for (const t of [...route.matchAll(/try\s*\{/g)]) {
        const open = t.index! + t[0].length - 1;
        if (open > at) break;
        let depth = 0;
        for (let i = open; i < route.length; i++) {
          if (route[i] === "{") depth++;
          else if (route[i] === "}") {
            depth--;
            if (depth === 0) {
              if (i > at) return true; // this try closes after the call
              break;
            }
          }
        }
      }
      return false;
    };

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
    // register to launder it through.
    expect(prompt).toMatch(/if \(!viewerIsClient\) parts\.push\(`- \*\*Status:\*\* \$\{client\.status\}`\)/);
    // job.status: RELABELLED through the register the run badges already read.
    expect(prompt).toContain("jobStatusLabel(j.status)");
    expect(prompt).toContain('from "@/lib/job-status-copy"');
    // asset.type: RELABELLED through the register the deliverable cards read.
    expect(prompt).toContain("assetTypeLabel(type)");
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
