import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_ASSET_STATUS_LABEL, publishHoldMessage } from "@/lib/asset-status-copy";
import {
  getClientArchiveAssets,
  getClientLibraryAssets,
  isInClientArchive,
} from "@/lib/asset-visibility";
import { CREDIT_DENIAL_PREFIX } from "@/lib/credits";
import {
  CLIENT_PUBLISH_FAILURE_MESSAGE,
  CLIENT_RUN_REFUSAL_MESSAGE,
  X_SETUP_REQUIRED_PREFIX,
  clientSafePublishError,
  clientSafeRunError,
} from "@/lib/custom-agent-launch";
import type { Asset } from "@/lib/types";

/**
 * Two promises this file pins.
 *
 * 1. A client's asset payload never carries `Asset.publishError` — the platform
 *    SDK's own exception. The field is written by the auto-publish cron, the
 *    manual-push action and the analytics reconciler, and read on four client
 *    surfaces (the calendar chip's tooltip, the projected CalendarPost, the
 *    dashboard's attention hint, the detail modal's "Publish failed" panel).
 *    Redaction happens at the two client asset projections, which is the last
 *    point it counts — RunCalendar receives the whole `Asset` for its modal, so
 *    a fix at the CalendarPost projection alone would have shipped the
 *    exception in the very same payload.
 *
 * 2. No client-facing screen claims "your Karos team has been notified" — in
 *    that wording or any synonym of it — unless something notifies them. On the
 *    client-fired run path nothing did. Exactly one site is allowlisted, by path,
 *    with what backs it named and re-checked here.
 *
 * The status REGISTERS the hold message draws its words from are pinned
 * separately, in asset-status-registers.test.ts.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/**
 * "…has been notified", and the synonyms that make the same promise.
 *
 * The rule is about the PROMISE, not the phrase: "been alerted" and "been
 * informed" commit us to exactly the same thing, so a guard that matched only
 * the first wording enforced its own literal rather than its name. The one
 * backed site in the app is allowlisted below.
 */
const NOTIFICATION_CLAIM = /been (?:notified|alerted|informed)/i;

/**
 * The claim is allowed exactly where something makes it true. One site
 * qualifies, and what backs it is named rather than assumed:
 * task-ticket-modal's "Send failed" alert renders only under
 * `metadata.failedUpload`, which `publishIntegrationAction` writes on the same
 * branch that emails ALERT_EMAIL about the dispatch failure. Verified, not
 * inherited — the test below re-checks both halves on every run.
 */
const BACKED_CLAIM_SITES = new Map([
  [
    "src/components/task-ticket-modal.tsx",
    {
      file: "src/lib/actions/execution-actions.ts",
      failureMarker: "failedUpload: true",
      alertMarker: "ALERT_EMAIL",
    },
  ],
]);

/**
 * A real one, verbatim from publishers.ts, with a fake URN and token bolted on
 * so a passing test cannot be an accident of a substring appearing elsewhere.
 */
const SDK_EXCEPTION =
  "Could not determine LinkedIn person URN (urn:li:person:zZsEnTiNeL) token=li_at_sEnTiNeL";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    clientId: "client-1",
    title: "Launch teaser",
    content: "Body",
    createdBy: "staff-1",
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 2 * DAY,
    status: "scheduled",
    type: "social_post",
    ...overrides,
  };
}

/**
 * A post the publish cron tried and failed to push. `status` stays "scheduled"
 * on failure by design (see calendar-kind.ts), and its day is past — so it is
 * UNLOCKED, which is why `redactLockedAsset`'s existing exclusion of this field
 * never applied to a single one of them.
 */
function failedPublish(overrides: Partial<Asset> = {}): Asset {
  return makeAsset({
    id: "failed-1",
    scheduledAt: NOW - 2 * DAY,
    publishError: SDK_EXCEPTION,
    ...overrides,
  });
}

describe("the client asset payload and a failed publish", () => {
  it("cannot carry the raw publish error out of the library projection", () => {
    const projected = getClientLibraryAssets(
      [
        failedPublish(),
        // A future-dated failure travels in the same array and takes the
        // redaction path instead. Asserting over the WHOLE serialized payload
        // covers both, and covers any field a later change starts copying the
        // error into.
        failedPublish({ id: "failed-locked", scheduledAt: NOW + 5 * DAY }),
      ],
      { forClient: true, now: NOW },
    );

    expect(JSON.stringify(projected)).not.toContain("sEnTiNeL");
    expect(projected.find((a) => a.id === "failed-1")?.publishError).toBe(
      CLIENT_PUBLISH_FAILURE_MESSAGE,
    );
  });

  it("cannot carry it out of the archive projection either", () => {
    // The other client projection: the agent detail page feeds
    // agentProducedAssets straight from here for a client viewer, and that set
    // reaches the same detail modal via the archive rows and the clip gallery
    // without ever passing getClientLibraryAssets.
    const projected = getClientArchiveAssets([failedPublish()], { now: NOW });

    expect(projected).toHaveLength(1);
    expect(JSON.stringify(projected)).not.toContain("sEnTiNeL");
  });

  it("still hands staff the exception, so the debugging path is intact", () => {
    // Same function, no forClient — the staff calendar, the staff library and
    // the Control Room all read the asset this way, and "Publish failed: <the
    // actual reason>" is the only thing that tells them which integration
    // broke.
    const staff = getClientLibraryAssets([failedPublish()]);

    expect(staff[0]!.publishError).toBe(SDK_EXCEPTION);
    expect(JSON.stringify(staff)).toContain("sEnTiNeL");
  });

  it("collapses every shape of platform error a publisher can throw", () => {
    for (const raw of [
      SDK_EXCEPTION,
      "No Instagram Business Account linked to any page",
      "Media container failed: (#100) The parameter caption is required",
      "Publisher not implemented for platform: reddit",
      "Unknown error",
    ]) {
      expect(clientSafePublishError(raw)).toBe(CLIENT_PUBLISH_FAILURE_MESSAGE);
    }
  });

  it("still tells the client something, and promises nothing unbacked", () => {
    // The original author of the "Publish failed" panel meant a client to learn
    // a reason — he just never sanitized it. Collapsing to a blank or to
    // silence would fix the leak by removing the information, so the message
    // must survive at all; and on this path (the cron writes the field, the
    // dashboard renders it) nothing emails anyone, so it may not say otherwise.
    //
    // What it must NOT do is pinned; the exact words are a copy decision, and a
    // `toContain("Karos team")` here only forbade legitimate rewords like
    // "we'll get it posted".
    expect(CLIENT_PUBLISH_FAILURE_MESSAGE).not.toBe("");
    expect(CLIENT_PUBLISH_FAILURE_MESSAGE).not.toMatch(NOTIFICATION_CLAIM);
    expect(CLIENT_PUBLISH_FAILURE_MESSAGE).not.toContain(" - ");
  });
});

describe("the ordering hold, the one publish error a client may read", () => {
  /** The usual blocker: the draft sitting behind the due post. */
  const hiddenBlocker = makeAsset({ id: "first", title: "Part 1 of 3", status: "draft" });
  /** The other kind: approved, past-dated, sitting in the client's archive. */
  const visibleBlocker = makeAsset({
    id: "first",
    title: "Part 1 of 3",
    status: "approved",
    scheduledAt: NOW - 3 * DAY,
  });

  const holdFor = (blocker: Asset) =>
    publishHoldMessage(blocker, { clientCanSeeBlocker: isInClientArchive(blocker, NOW) });

  it("survives the sanitizer either way, because both are written as client copy", () => {
    // Both branches have to open with the allowlisted prefix. If a reword drops
    // it from one of them, that branch is silently collapsed to the generic
    // failure line and the client loses the explanation for a benign wait.
    for (const blocker of [hiddenBlocker, visibleBlocker]) {
      const held = holdFor(blocker);
      expect(clientSafePublishError(held)).toBe(held);
      // And it reaches the client through the projection intact.
      const projected = getClientArchiveAssets([failedPublish({ publishError: held })], {
        now: NOW,
      });
      expect(projected[0]!.publishError).toBe(held);
    }
  });

  it("is the only hold wording that survives it", () => {
    // The pre-fix message was composed inline in the cron route. If anyone
    // reinstates a hand-rolled hold string, it collapses to the generic
    // sentence rather than being waved through on a loose prefix match — which
    // is the failure mode a two-word allowlist ("Waiting for…") would have.
    const handRolled = `Waiting for "Part 1 of 3" - it comes earlier in this series and is still draft.`;
    expect(clientSafePublishError(handRolled)).toBe(CLIENT_PUBLISH_FAILURE_MESSAGE);
  });

  it("renders the status label instead of the stored enum, and carries no spaced hyphen", () => {
    for (const status of Object.keys(CLIENT_ASSET_STATUS_LABEL) as Asset["status"][]) {
      const message = publishHoldMessage(
        { title: "Part 1 of 3", status },
        { clientCanSeeBlocker: true },
      );
      // Ledger F71: " - " is banned in client copy, and this line reintroduced it.
      expect(message).not.toContain(" - ");
      expect(message).toContain("—");
      expect(message).toContain(CLIENT_ASSET_STATUS_LABEL[status]);
      // The raw enum is lowercase and every rendered label is capitalised, so
      // the enum appearing at all means it was interpolated as prose.
      expect(message).not.toContain(status);
    }
  });

  it("never names a post the client cannot open", () => {
    // The common case. `blockingPredecessor` takes any status but "published",
    // so the blocker is usually a draft — and no client surface lists a draft
    // (isInClientArchive excludes them; see client-home-overview's attention
    // row, which is deliberately not a link for the same reason). Naming its
    // title also hands over unapproved copy, which is why redactLockedAsset
    // replaces titles rather than passing them.
    expect(isInClientArchive(hiddenBlocker, NOW)).toBe(false);
    const message = holdFor(hiddenBlocker);
    expect(message).not.toContain("Part 1 of 3");
    for (const label of Object.values(CLIENT_ASSET_STATUS_LABEL)) {
      expect(message, `named the status "${label}" of a post the client cannot see`).not.toContain(
        label,
      );
    }
    // It still says who is holding it — a hold with no explanation reads as a
    // failure, and this one is benign and self-clearing.
    expect(message).toMatch(/Karos team/);

    // And the visible case is the one that keeps the name and the status.
    expect(isInClientArchive(visibleBlocker, NOW)).toBe(true);
    expect(holdFor(visibleBlocker)).toContain("Part 1 of 3");
    expect(holdFor(visibleBlocker)).toContain(CLIENT_ASSET_STATUS_LABEL.approved);
  });

  it("uses the client's word for the grouping, and calls the held post theirs", () => {
    // "Format" is what every other client-facing surface calls this grouping
    // (live-card: "In your Workspace under this format"; launch-card: "the set
    // of post formats this agent will produce"). "Series" is our internal word
    // for it (post-chain.ts) and appears in no rendered string.
    //
    // And no possessive that splits the two posts between owners: the message
    // used to close "Yours goes out once that one is posted", implying the other
    // one belonged to somebody else. Both are the client's.
    for (const blocker of [hiddenBlocker, visibleBlocker]) {
      const message = holdFor(blocker);
      expect(message).not.toMatch(/\bseries\b/i);
      expect(message).toContain("this format");
      expect(message).not.toMatch(/\byours\b/i);
    }
  });
});

/* ── source-level guards ─────────────────────────────────────────────────
   The publish cron is a route handler over Firestore, and the banners below are
   server components — none of them can be invoked from a unit test. These read
   the source, the same way activity-timeline-boundary.test.ts does, and assert
   the guarantee rather than the presence of a line.                         */

const ROOT = process.cwd();

/**
 * Source with comments removed. The negative assertions say "this does not
 * appear in the CODE"; run against the raw file they would also fire on the
 * docstrings that explain why it must not, making the honest way to keep them
 * green deleting the explanation.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every source file in the app, excluding the tests (which quote the strings). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(join(dir, entry.name)));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe("a client-fired run refusal", () => {
  it("makes no claim that anyone was notified", () => {
    // The sentence used to read "Your Karos team has been notified." for every
    // agent-service outage, timeout and 5xx — and on that path there is no
    // email, no Slack, no task, no activity row and no logger. The scheduled
    // twin pairs a weaker sentence with a real alert
    // (notifyScheduleFireFailure); the client-fired path paired the stronger
    // claim with nothing.
    const safe = clientSafeRunError("connect ECONNREFUSED 10.4.0.9:8080");
    expect(safe).toBe(CLIENT_RUN_REFUSAL_MESSAGE);
    expect(safe).not.toMatch(NOTIFICATION_CLAIM);
    // Still actionable: both the things a client can actually do.
    expect(safe).toMatch(/again/i);
    expect(safe).toContain("Karos team");
  });

  // Named for what the pattern actually matches. It is three synonyms, not every
  // way of promising a notification — "we've let your Karos team know" and "your
  // team is aware" both pass. Widen NOTIFICATION_CLAIM if a fourth wording ever
  // ships; do not widen this name past the assertion.
  it("leaves no screen in the app making the claim, in any of the three wordings it has taken", () => {
    // Two more sites hard-coded it outside the helper (the client agent roster
    // and the agent detail page, both for an unconfigured agent service).
    // Fixing the helper and leaving those is not a fix, so the guarantee is
    // repo-wide rather than per-file — and it is about the PROMISE, so a
    // reworded "we have been informed" cannot slip past it either.
    const offenders = sourceFiles(join(ROOT, "src"))
      .map((file) => file.slice(ROOT.length + 1).split(sep).join("/"))
      .filter((rel) => NOTIFICATION_CLAIM.test(code(readFileSync(join(ROOT, rel), "utf8"))))
      .filter((rel) => !BACKED_CLAIM_SITES.has(rel));

    expect(offenders).toEqual([]);
  });

  it("keeps its one allowlisted site honest: still claimed, and still backed", () => {
    // An allowlist entry that stops being true is the same defect as the claim
    // itself, one indirection out — a stale entry would silently permit a NEW
    // unbacked claim in that file. So both halves are checked: the file still
    // makes the claim, and the code behind it still does the alerting.
    for (const [rel, backing] of BACKED_CLAIM_SITES) {
      const src = code(readFileSync(join(ROOT, rel), "utf8"));
      expect(NOTIFICATION_CLAIM.test(src), `${rel} no longer claims it — drop the entry`).toBe(
        true,
      );
      const backingSrc = code(readFileSync(join(ROOT, backing.file), "utf8"));
      // The alert is sent on the same branch that raises the badge this banner
      // renders under, so the window between them is what has to hold.
      const onFailure = backingSrc.slice(backingSrc.indexOf(backing.failureMarker));
      expect(backingSrc).toContain(backing.failureMarker);
      expect(
        onFailure.slice(0, 1500),
        `${backing.file} no longer alerts on the failure path that ${rel} promises`,
      ).toContain(backing.alertMarker);
    }
  });

  it("still passes a setup refusal and a credit denial through verbatim", () => {
    // Over-collapsing is the other failure: these two ARE written for the
    // client, and the run dialog links off the setup one.
    const setup = `${X_SETUP_REQUIRED_PREFIX} first. Open the "X agent data" page.`;
    expect(clientSafeRunError(setup)).toBe(setup);
    const denial = `${CREDIT_DENIAL_PREFIX.insufficient_balance} 25 credits and 3 are left.`;
    expect(clientSafeRunError(denial)).toBe(denial);
  });
});

describe("the publish cron's held-post message", () => {
  const route = code(readFileSync(join(ROOT, "src/app/api/publish/route.ts"), "utf8"));

  it("is composed by the shared builder, not inline", () => {
    // Inline composition is how the spaced hyphen and the raw enum got onto a
    // client's screen, and an inline rewrite would no longer be allowlisted by
    // clientSafePublishError either — the client would silently lose the
    // explanation for a benign, self-clearing wait.
    //
    // Matched on the CALL, not on its argument list: pinning
    // "publishHoldMessage(blocker)" also failed when the local variable was
    // renamed or a second argument was added, neither of which is the loosening
    // this forbids.
    expect(route).toMatch(/publishHoldMessage\(/);
    expect(route).not.toContain('Waiting for "');
  });

  it("asks the shared predicate whether the blocker may be named", () => {
    // "Can the client see this asset?" has one home (isInClientArchive). A
    // hand-rolled answer here — `blocker.status !== "draft"` — is how the copy
    // helper would start naming posts the client cannot open again, and it would
    // also disagree with the archive on a future-dated or aged-out blocker.
    expect(route).toMatch(/isInClientArchive\(/);
    expect(route).not.toContain("blocker.status");
  });
});
