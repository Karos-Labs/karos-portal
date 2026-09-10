import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClientHomeOverview, failedPublishText } from "@/components/client-home-overview";
import { CLIENT_PUBLISH_FAILURE_MESSAGE } from "@/lib/custom-agent-launch";
import type { Asset } from "@/lib/types";

/**
 * The dashboard's "N posts failed to publish" row: what it QUOTES, and where it
 * SENDS the reader.
 *
 * The leak this row was reported for is closed upstream and stays closed there:
 * `Asset.publishError` holds the platform SDK's exception, and both client asset
 * projections collapse it through `clientSafePublishError` before it can cross
 * the RSC boundary (pinned in publish-error-boundary.test.ts, which is the test
 * for the PAYLOAD). What was never mechanical is this row's own side of it — the
 * component's docstring said `assets` "MUST arrive already redacted" and the
 * render quoted the field verbatim, so the guard against a mount forgetting the
 * projection was a sentence in a comment.
 *
 * That is now keyed to this component's own `viewerIsClient` argument, through
 * the SAME function the boundary calls. Two callers of one rule, not two
 * spellings of it — which is why the tests below can assert the client and staff
 * answers against the shared constant rather than against a second literal.
 *
 * The other half is the destination. A bare `/calendar` is the CROSS-CLIENT
 * overview for staff, so the row on one client's dashboard opened every client's
 * grid.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/**
 * A real exception shape from publishers.ts with a sentinel bolted in, so a
 * passing negative cannot be an accident of a substring appearing elsewhere.
 */
const SDK_EXCEPTION =
  "Could not determine LinkedIn person URN (urn:li:person:zZsEnTiNeL) token=li_at_sEnTiNeL";

function failedPost(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "failed-1",
    clientId: "c1",
    title: "Launch teaser",
    content: "Body",
    createdBy: "staff-1",
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 2 * DAY,
    // A failed publish keeps "scheduled" by design (calendar-kind.ts) — the
    // stored error is the only signal — and its day is past, so `postKind`
    // classifies it "failed" and the attention row counts it.
    status: "scheduled",
    scheduledAt: NOW - 2 * DAY,
    publishError: SDK_EXCEPTION,
    type: "social_post",
    ...overrides,
  };
}

/**
 * The constant as React writes it into markup. Derived from the constant rather
 * than re-typed, so a reword of the sentence cannot leave this test asserting
 * the old one — the apostrophe in "didn't" is escaped on the way out.
 */
function asMarkup(s: string): string {
  return s.replace(/'/g, "&#x27;");
}

function overview(viewerIsClient: boolean, assets: Asset[] = [failedPost()]): string {
  return renderToStaticMarkup(
    createElement(ClientHomeOverview, { clientId: "c1", tasks: [], assets, viewerIsClient }),
  );
}

describe("what the failed-publish row quotes", () => {
  it("hands a client the shared safe sentence, never the exception", () => {
    expect(failedPublishText(failedPost(), true)).toBe(CLIENT_PUBLISH_FAILURE_MESSAGE);
    expect(failedPublishText(failedPost(), false)).toBe(SDK_EXCEPTION);
  });

  it("is idempotent on an already-projected asset, which is the normal path", () => {
    // On every live route the server boundary has already run, so this second
    // call has to be a no-op — otherwise the row would be collapsing the safe
    // sentence into some third thing, or the two answers would depend on how
    // many times the rule ran.
    const projected = failedPost({ publishError: CLIENT_PUBLISH_FAILURE_MESSAGE });
    expect(failedPublishText(projected, true)).toBe(CLIENT_PUBLISH_FAILURE_MESSAGE);
  });

  it("keeps the in-house fallback out of the sanitizer", () => {
    // A missing field is not a stored publish error. Feeding our own line to a
    // function whose job is to collapse anything unrecognised would silently
    // replace it with the generic sentence — a fix that quietly deletes copy.
    const noError = failedPost({ publishError: undefined });
    expect(failedPublishText(noError, true)).toBe("Review it on the calendar.");
    expect(failedPublishText(noError, false)).toBe("Review it on the calendar.");
  });

  it("puts no exception on the rendered card, and still puts one in front of staff", () => {
    // The render, not just the helper — the helper could be right and unwired.
    const forClient = overview(true);
    // Non-vacuity first: the row rendered at all. Every negative under this is
    // worthless over markup that never drew the card.
    expect(forClient, "the attention row never rendered").toContain("failed to publish");
    expect(forClient, "the SDK exception reached a client's dashboard").not.toContain("sEnTiNeL");
    expect(forClient).toContain(asMarkup(CLIENT_PUBLISH_FAILURE_MESSAGE));

    // The neighbouring case, off the same fixture, which is what makes the
    // negative a VIEWER rule rather than a deletion: staff debug with this.
    const forStaff = overview(false);
    expect(forStaff, "staff lost the only line naming the broken integration").toContain(
      "sEnTiNeL",
    );
  });
});

describe("where the failed-publish row sends the reader", () => {
  it("opens this client's calendar for staff, and the flat one for a client", () => {
    // `/calendar` is the cross-client overview for a staff viewer — the same
    // wrong-surface defect `clientArchiveLink` fixes for the archive and
    // `taskBoardHref` for the board, left standing on this row.
    expect(overview(false)).toContain('href="/clients/c1/calendar"');
    // A client has no client-scoped calendar route: /clients/[id]/calendar
    // redirects a CLIENT_USER straight back to /calendar, so theirs stays flat.
    const forClient = overview(true);
    expect(forClient).toContain('href="/calendar"');
    expect(forClient, "a client was sent to a staff route").not.toContain("/clients/c1/calendar");
  });

  it("does not raise the row for an ordering HOLD, which asks nothing of anyone", () => {
    // Rule 6, the other direction: the sanitizer passes the hold sentence
    // through verbatim, so a fix that keyed the row on "is publishError set"
    // would put a red attention row over a paragraph explaining that nothing is
    // wrong. `postKind` is what tells the two apart, and this is the case that
    // proves the row still asks it.
    const held = failedPost({
      publishError:
        "This post is waiting for an earlier post in this format that isn't in your Workspace " +
        "yet — your Karos team is getting it out. This post goes out once that one is posted (or removed).",
    });
    const html = overview(true, [held]);
    expect(html, "a benign hold was raised as a failure").not.toContain("failed to publish");
    // Non-vacuity: the card itself rendered, so the absence above is the
    // classification and not an empty render.
    expect(html).toContain("Needs your attention");
  });
});
