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

  it("offers every kind in the legend, by shape and not by a list", () => {
    // An array satisfies its element type however short it is, so the legend
    // could name fewer kinds than the grid draws and the filter could not hide
    // what it did not name. A Record over the key type cannot.
    expect(flat(cal)).toContain("STATUS_FILTER_CHIPS: Record<StatusFilterKey");
  });
});
