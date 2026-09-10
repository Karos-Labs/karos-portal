import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { stripComments } from "./source-scan";

/**
 * STAFF DO NOT CONFIRM A CLIENT'S DOCUMENT (round 6 review, D1).
 *
 * "Looks right" writes a `ClientActionState` row (21 / 22 / 23) against the
 * client's own account and ticks step 2 of THEIR setup ladder; "Something is
 * off" opens Support about THEIR document. Both are answers only the client can
 * give, and `ClientDocuments` mounts for staff too — the settings page renders
 * the same tab for an operator reading the account for their own reasons.
 *
 * ASKED OF THE RENDER, in both directions, because that is the guarantee: a
 * control that is not in the markup cannot fire the write, whereas a source
 * scan for `canConfirm` is satisfied by the word appearing anywhere in the
 * file. The parity half is asserted too — the read-only "Confirmed" line still
 * renders for staff once the client HAS answered, so staff read the same fact
 * in the same place with one control withheld (the shape
 * `GetSetUpWidget`'s `canHide` established).
 *
 * `renderToStaticMarkup` runs no effects, which is why the panel is opened
 * through the URL (`?doc=&for=`) rather than by a click: that is the same
 * initial state the ladder's own landing produces.
 */

vi.mock("server-only", () => ({}));
// The document reader's module graph reaches the server-action barrel through
// three components (its own summary/regenerate calls, the correction modal, the
// Support modal). None of them is called by a static render — and
// `markActionDoneAction` is the one this file is about, so it is a spy.
// `vi.hoisted` because `vi.mock`'s factory is lifted above every other
// statement in the file, spy declarations included.
const { markActionDoneAction } = vi.hoisted(() => ({ markActionDoneAction: vi.fn() }));
vi.mock("@/lib/actions", () => ({
  generateDocSummaryAction: vi.fn(),
  generateIntelReportAction: vi.fn(),
  markActionDoneAction,
  applyTargetedDocCorrectionAction: vi.fn(),
  sendSupportEmailAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("doc=brand-voice&for=voice"),
}));

import { ClientDocuments } from "@/components/client-documents";
import type { ClientContextDoc } from "@/lib/types";

const REPO = join(__dirname, "..", "..", "..");
const DOCS = "src/components/client-documents.tsx";
const code = () => stripComments(readFileSync(join(REPO, DOCS), "utf8"));

const brandVoice: ClientContextDoc = {
  id: "doc-1",
  clientId: "c1",
  docType: "brand-voice",
  tier: "client",
  content:
    "## Voice\n\nPlain, direct sentences. No exclamation marks, no hype, and never more than one idea per line.\n",
  version: 3,
  createdAt: 1,
  updatedAt: 2,
};

function markup(props: { canConfirm?: boolean; confirmed?: boolean }): string {
  return renderToStaticMarkup(
    <ClientDocuments
      contextDocs={[brandVoice]}
      clientId="c1"
      {...(props.canConfirm === undefined ? {} : { canConfirm: props.canConfirm })}
      confirmedDocTypes={props.confirmed ? (["brand-voice"] as const) : []}
    />,
  );
}

describe("the document confirmation is the client's to give", () => {
  it("offers both halves to a client viewer", () => {
    const html = markup({ canConfirm: true });
    expect(html).toContain("Looks right");
    expect(html).toContain("Something is off in your Brand Voice?");
  });

  it("withholds both halves from a staff viewer", () => {
    const html = markup({ canConfirm: false });
    // The document itself is still there — this is one control withheld, not a
    // different screen.
    expect(html).toContain("Brand Voice");
    expect(html, "staff can tick a client's setup ladder").not.toContain("Looks right");
    expect(html, "staff can open Support about a client's document").not.toContain(
      "Something is off",
    );
    // …and no question addressed to somebody who cannot answer it.
    expect(html).not.toContain("describe you?");
  });

  it("defaults to withholding when no caller says otherwise", () => {
    // A new mount that forgets the prop must not get the write for free.
    expect(markup({})).not.toContain("Looks right");
  });

  it("still shows staff the answer the client already gave", () => {
    const html = markup({ canConfirm: false, confirmed: true });
    expect(html).toContain("looks right. Every draft is checked against it.");
    expect(html).toContain("Confirmed");
    expect(html, "the control came back with the read-only line").not.toContain("Looks right<");
  });

  it("never builds the write handler for a viewer who may not confirm", () => {
    // The render pins the control's absence; this pins the CHANNEL's absence,
    // so the write cannot come back through a future call site that renders a
    // button of its own.
    const src = code();
    // Anchored on the WRITE and read backwards, so the assertion is about what
    // guards this call rather than about which `onConfirm=` happens to come
    // first in the file (the panel forwards the prop on to the foot as well).
    const write = src.indexOf("markActionDoneAction(clientId, actionId)");
    expect(write, "the confirm write moved").toBeGreaterThan(-1);
    const guard = src.slice(Math.max(0, write - 300), write);
    expect(guard).toMatch(/canConfirm && clientId && actionId/);
    expect(
      src.match(/markActionDoneAction\(/g)?.length,
      "a second, unguarded call site",
    ).toBe(1);
    expect(markActionDoneAction, "a static render wrote to Firestore").not.toHaveBeenCalled();
  });
});
