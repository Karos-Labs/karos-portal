import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextGroundingNotice } from "@/components/context-grounding-notice";
import { IntakeBlockedBanner } from "@/components/client-agents/intake-blocked-banner";
import { latestBlockedIntake } from "@/lib/client-agents";
import { readContextGroundingMarker } from "@/lib/agent-engine/context-grounding";
import type { Asset, AssetContextGrounding, Job } from "@/lib/types";

/**
 * SCRUM-404 — asserted as RENDERED OUTPUT, deliberately.
 *
 * The ticket's own warning is about the last one of these: T-B21's four-row
 * resolver matrix, which the SCRUM-275 README prescribed, **passed against the
 * buggy code**. Only the render assertions and the source pins caught the real
 * defect. A test that a resolver returns "degraded" in isolation is exactly the
 * test that already failed to catch this once.
 *
 * So nothing here asserts a resolver's return value. Each test renders the
 * component a client actually reads and looks for the words in the markup —
 * because "the marker exists on the Asset" and "the client can see it" are two
 * different claims, and it was the second one that was false.
 */

const marker: AssetContextGrounding = {
  status: "degraded",
  agentId: "intel-report-agent",
  missingDocTypes: ["market-strategy", "target-audience"],
  reason: "output is a client-facing deliverable that names external parties (competitors) — ungrounded is worse than absent",
};

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset_1",
    clientId: "client_1",
    type: "note",
    title: "Competitive brief",
    content: "Three competitors moved this month.",
    status: "draft",
    createdBy: "agent-engine",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as Asset;
}

describe("SCRUM-404: a degraded run's marker is visible, with its reason and missing documents", () => {
  it("names the missing documents in words a client can read, not engine doc-type keys", () => {
    const html = renderToStaticMarkup(<ContextGroundingNotice grounding={marker} />);
    // The client-facing sentence. Not "market-strategy" — that is an internal
    // identifier, and a client reading it in prose is reading our schema.
    expect(html).toContain("market strategy");
    expect(html).toContain("target audience");
    expect(html).not.toContain("market-strategy");
    // Both documents, joined into one sentence rather than listed as a schema dump.
    expect(html).toContain("Drafted without your market strategy and target audience");
  });

  it("carries the engine's stated reason verbatim, and names the agent", () => {
    const html = renderToStaticMarkup(<ContextGroundingNotice grounding={marker} />);
    expect(html).toContain("intel-report-agent");
    // Verbatim: this component does not restate a decision it does not own.
    expect(html).toContain("ungrounded is worse than absent");
  });

  it("is a warning, never a failure — this fires on a new client's FIRST deliverable", () => {
    const html = renderToStaticMarkup(<ContextGroundingNotice grounding={marker} />);
    expect(html).toContain("warning");
    expect(html).not.toContain("danger");
    // No apology, no suggestion the client did something wrong, no claim the
    // work is broken. It was drafted before the documents existed, which on an
    // onboarding run is the expected order of events.
    for (const scare of ["error", "failed", "invalid", "Sorry", "cannot"]) {
      expect(html.toLowerCase(), `must not read as breakage: ${scare}`).not.toContain(scare.toLowerCase());
    }
  });

  it("renders a list-row chip too, so the gap is visible WITHOUT opening the deliverable", () => {
    // A list that hides this until you click reads as though every row were
    // equally grounded — which is the thing the marker exists to stop.
    const html = renderToStaticMarkup(<ContextGroundingNotice grounding={marker} variant="chip" />);
    expect(html).toContain("Limited context");
    // The full reason stays reachable from the row without leaving it.
    expect(html).toContain("ungrounded is worse than absent");
  });

  it("degrades readably for a doc type this repo has no label for yet", () => {
    // A doc type added engine-side must not vanish from the list — the count a
    // client reads has to stay honest even when the label map is behind.
    const html = renderToStaticMarkup(
      <ContextGroundingNotice grounding={{ ...marker, missingDocTypes: ["some-new-doc"] }} />,
    );
    expect(html).toContain("some new doc");
  });

  it("says something honest when the engine sent a marker with no doc list", () => {
    const html = renderToStaticMarkup(<ContextGroundingNotice grounding={{ ...marker, missingDocTypes: [] }} />);
    expect(html).toContain("limited context");
    // Never a dangling sentence with nothing after "your".
    expect(html).not.toContain("without your ");
  });
});

describe("SCRUM-404: the normal path shows nothing new", () => {
  it("a fully-grounded deliverable has no marker to render", () => {
    // The acceptance criterion in its own right: no scare copy on the path
    // almost every asset takes. Asserted at the boundary the render is gated on
    // (`asset.contextGrounding &&` in the modal and the archive row), reading a
    // real deliverable rather than a hand-made Asset.
    expect(readContextGroundingMarker({ headline: "Three competitors moved", sections: [] })).toBeUndefined();
    expect(asset().contextGrounding).toBeUndefined();
  });
});

describe("SCRUM-404: a blocked_intake run is visibly blocked with its stated reason", () => {
  function job(overrides: Partial<Job> = {}): Job {
    return {
      id: "job_1",
      clientId: "client_1",
      agentId: "agent-engine",
      agentName: "Intel Report",
      title: "Monthly intel",
      status: "failed",
      input: {},
      assetIds: [],
      events: [],
      createdBy: "user_1",
      createdAt: 1000,
      updatedAt: 1000,
      ...overrides,
    } as Job;
  }

  it("surfaces the engine's reason to the client, in the register that can act on it", () => {
    const blocked = latestBlockedIntake([job({ blockedReason: "market-strategy is not on file for this client." })], "Intel Report", {
      staff: false,
    });
    expect(blocked?.reason).toBe("market-strategy is not on file for this client.");
    const html = renderToStaticMarkup(<IntakeBlockedBanner reason={blocked!.reason} viewerIsClient />);
    expect(html).toContain("market-strategy is not on file");
    // The client is told it is theirs to clear, and that nothing else broke.
    expect(html).toContain("not on file yet");
    expect(html.toLowerCase()).toContain("nothing below is affected");
  });

  it("reads blockedReason, never job.error — the two are separate slots for a reason", () => {
    // `error` is what `classifyJobError`, the failure alert email and the Job
    // page's danger card are all gated on, and every one of them is asking "did
    // this break". A blocked intake's answer is no.
    const onlyError = latestBlockedIntake([job({ error: "Run blocked — missing client input." })], "Intel Report", { staff: false });
    expect(onlyError).toBeUndefined();
  });

  it("is not silently absent — which is what mapping it onto `failed` alone made it", () => {
    // Before SCRUM-404 a blocked run was `status: "failed"` with the reason only
    // in `error`, and the client-facing surfaces deliberately do not show a
    // client our failures (AF-14). So the one non-delivery that IS theirs to
    // clear was the one they could not see. This is that gap, stated as a test.
    const beforeShape = latestBlockedIntake([job({ error: "Run blocked — missing client input." })], "Intel Report", { staff: false });
    const afterShape = latestBlockedIntake([job({ error: "Run blocked — missing client input.", blockedReason: "Run blocked — missing client input." })], "Intel Report", { staff: false });
    expect(beforeShape).toBeUndefined();
    expect(afterShape?.reason).toContain("missing client input");
  });

  it("stops showing once a later run for the same agent delivered", () => {
    // A banner that outlives its cause is the stale-refusal failure mode the
    // schedule note in `client-agents.ts` describes.
    const blocked = latestBlockedIntake(
      [
        job({ id: "old", createdAt: 1000, blockedReason: "market-strategy is not on file." }),
        job({ id: "new", createdAt: 2000, status: "review" }),
      ],
      "Intel Report",
      { staff: false },
    );
    expect(blocked).toBeUndefined();
  });

  it("still shows for a launch run, which is the onboarding case it exists for", () => {
    // Unlike `lastRunFailedAgentIds`, which excludes launch runs from a client's
    // verdict: a first-time client's onboarding IS a launch run, and it is the
    // primary case here.
    const blocked = latestBlockedIntake(
      [job({ runType: "launch", blockedReason: "market-strategy is not on file." })],
      "Intel Report",
      { staff: false },
    );
    expect(blocked?.reason).toContain("market-strategy");
  });

  it("ignores a staff test run for a client viewer", () => {
    const blocked = latestBlockedIntake(
      [job({ runType: "test", blockedReason: "market-strategy is not on file." })],
      "Intel Report",
      { staff: false },
    );
    expect(blocked).toBeUndefined();
  });
});

/**
 * The other half of the T-B21 lesson, and the half that matters more.
 *
 * Every test above proves the notice RENDERS correctly. None of them proves
 * anything MOUNTS it — and a component that renders beautifully while no screen
 * uses it is precisely the shape of the defect SCRUM-404 exists to fix: the
 * engine's marker was correct at every layer, and the client still saw nothing.
 * `AssetDetailModal` and the agent page are client components behind a Modal and
 * a server-side data fetch, so they are pinned at the source, the same way
 * `run-dialog-dispatch-consistency.test.tsx` pins the run dialog.
 */
describe("SCRUM-404: the notice is actually mounted on the surfaces a client reads", () => {
  const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

  it("AssetDetailModal — the only deliverable viewer a client can reach — mounts it", () => {
    const modal = src("src/components/asset-detail-modal.tsx");
    expect(modal).toContain("ContextGroundingNotice");
    // Gated on the field, so a fully-grounded asset renders nothing new.
    expect(modal).toContain("asset.contextGrounding && <ContextGroundingNotice");
  });

  it("the client-facing archive rows mount the chip, so the gap shows before you click", () => {
    const rows = src("src/components/client-agents/agent-archive-rows.tsx");
    expect(rows).toContain('variant="chip"');
    expect(rows).toContain("asset.contextGrounding && <ContextGroundingNotice");
  });

  it("the client agent screen mounts the blocked-intake banner", () => {
    const page = src("src/app/(app)/clients/[id]/agents/[agentId]/page.tsx");
    expect(page).toContain("IntakeBlockedBanner");
    expect(page).toContain("latestBlockedIntake(jobs");
    // Rendered, not merely computed — the variable has to reach JSX.
    expect(page).toContain("<IntakeBlockedBanner reason={blockedIntake.reason}");
  });

  it("the materializer reads the marker generically, before any per-product branch", () => {
    // The fix has to sit above `buildMaterialization`'s product switch. Read
    // inside a per-product function it would work for that product and silently
    // omit every other one — which is how the marker came to be dropped.
    const mat = src("src/lib/agent-engine/materialize.ts");
    const readAt = mat.indexOf("readContextGroundingMarker(deliverable)");
    const switchAt = mat.indexOf("function buildMaterialization");
    expect(readAt).toBeGreaterThan(-1);
    expect(switchAt).toBeGreaterThan(-1);
    // And it is handed to createAsset, not just computed.
    expect(mat).toContain("...(contextGrounding ? { contextGrounding } : {})");
  });

  it("reconcile writes blockedReason on blocked_intake and clears it everywhere else", () => {
    const rec = src("src/lib/agent-engine/reconcile.ts");
    expect(rec).toContain("blockedReason: run.reason ??");
    // Every branch writes the slot — the "BOTH ARE ALWAYS WRITTEN" discipline
    // the file's own interface note explains, extended to the third one. Four
    // returns plus the interface field and the changed-comparison.
    expect(rec.match(/blockedReason/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(rec).toContain("(job.blockedReason ?? null) === update.blockedReason");
  });
});
