import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE RUN DIALOG AND THE SUBMIT CORE MUST RESOLVE THE SAME `engineProductId`
 * (T-B21's one mandatory fix; T-B12's C3 second mandatory fix restated).
 *
 * The dialog decides which fields to PAINT from an engine product id; the
 * submit core decides where the run actually GOES from an engine product id.
 * When those two ids disagree, the dialog shows a field the server does not
 * agree on — and the value typed into it is dropped without a word.
 *
 * They disagreed. `submit-custom.ts:548` asks
 * `resolveDispatchedAgentEngineProductId(agent.key, client.agentsRepoSlug)` —
 * the three-part gate (dispatch flag ON, this client on
 * `AGENT_ENGINE_CUSTOM_AGENT_CLIENTS`, key routable). The dialog asked
 * `resolveAgentEngineProductIdForCustomAgent(agent.key)`, which answers only
 * the third part. For every client not yet cut over — the normal state
 * mid-migration, and the state this whole drain exists to move clients out of
 * one at a time — the dialog painted "Direction for this run (optional)" and,
 * on the media products, "Source media", then handed the run to agent-service,
 * which reads neither field.
 *
 * This is the same defect SCRUM-249/T-B5 closed in the copilot chat route (see
 * health.ts's own doc comment, which documents that fix and states that its
 * function IS the definition of "would actually dispatch"). The chat route was
 * fixed; the run dialog was not. This suite is the pin that stops it coming
 * back at either call site.
 *
 * WHY IT IS NOT A RESOLVER-IN-ISOLATION TEST. A suite that only checked
 * `resolveDispatchedAgentEngineProductId`'s own truth table would have passed,
 * green, on every day this bug shipped — health.test.ts already has exactly
 * that suite and it did pass. What was wrong was never the resolver: it was
 * which question the dialog asked. So every row below asks the question through
 * the SAME path the dialog now takes (the server-built `EngineDispatchMap` and
 * `engineProductIdForPair`), compares it against the SAME call the submit core
 * makes, and the vacuity guard proves the old key-only answer would fail here.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actions", () => ({
  createCustomAgentAction: vi.fn(),
  deleteCustomAgentAction: vi.fn(),
  runCustomAgentAction: vi.fn(),
  runCustomAgentTestAction: vi.fn(),
  setClientCustomAgentsAction: vi.fn(),
  setCustomAgentEnabledAction: vi.fn(),
  updateCustomAgentAction: vi.fn(),
}));
vi.mock("@/lib/actions/planned-run-actions", () => ({
  configureClientAgentScheduleAction: vi.fn(),
  deletePlannedRunAction: vi.fn(),
  setPlannedRunStatusAction: vi.fn(),
}));
vi.mock("@/lib/actions/external-job-actions", () => ({
  cancelClientAgentJobAction: vi.fn(),
  refreshJobStatusAction: vi.fn(),
  retryJobAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
// `Modal` portals into `document.body` and this suite runs in node, same as
// run-dialog-setup-gate-copy.test.tsx. The subject is which FIELDS the dialog
// paints, and those are the same children either way.
vi.mock("@/components/modal", () => ({
  Modal: ({ children, footer }: { children?: React.ReactNode; footer?: React.ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

import { RunCustomAgentModal } from "@/components/custom-agents";
import {
  buildEngineDispatchMap,
  engineProductIdForPair,
} from "../engine-dispatch-map";
import { resolveDispatchedAgentEngineProductId } from "../health";
import { resolveAgentEngineProductIdForCustomAgent } from "../product-mapping";
import {
  initialAgentBrief,
  launchProfileFor,
  reseedAgentBrief,
  withEngineRunFields,
} from "@/lib/custom-agent-launch";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The client the matrix is asked about, exactly as the page has it. */
const CLIENT = { id: "client-1", name: "Acme", agentsRepoSlug: "acme" } as const;
/** A real routable key, and a real media product so BOTH engine fields are in play. */
const ROUTABLE_KEY = "karos-instagram-agent";
const ROUTABLE_PRODUCT = "instagram-agent";
/** A key agent-engine has no workflow for — the third part of the gate, failing. */
const UNROUTABLE_KEY = "karos-intel-report-agent";

const AGENT = {
  id: "agent-1",
  key: ROUTABLE_KEY,
  name: "Instagram Agent",
  clientBlurb: "Drafts carousels for your team to review.",
  icon: "Sparkles",
  color: "#A3E635",
  enabled: true,
} as const;

/**
 * The environment for one row of the matrix, set on the real `process.env` the
 * two flag functions read — stubbing the predicate itself would test the mock.
 */
function applyFlags(row: { dispatchEnabled: boolean; clientAllowlisted: boolean }) {
  vi.stubEnv("AGENT_ENGINE_DISPATCH_ENABLED", row.dispatchEnabled ? "true" : "false");
  // A non-empty allowlist that names SOMEONE ELSE, never an empty one: unset
  // means nobody, so an empty string would let a row pass for the wrong reason.
  vi.stubEnv(
    "AGENT_ENGINE_CUSTOM_AGENT_CLIENTS",
    row.clientAllowlisted ? CLIENT.agentsRepoSlug : "some-other-client",
  );
}

const MATRIX = [
  {
    name: "dispatch flag off, client allowlisted, key routable → legacy path",
    dispatchEnabled: false,
    clientAllowlisted: true,
    agentKey: ROUTABLE_KEY,
    expected: undefined,
  },
  {
    name: "dispatch flag on, client NOT allowlisted, key routable → legacy path",
    dispatchEnabled: true,
    clientAllowlisted: false,
    agentKey: ROUTABLE_KEY,
    expected: undefined,
  },
  {
    name: "dispatch flag on, client allowlisted, key NOT routable → legacy path",
    dispatchEnabled: true,
    clientAllowlisted: true,
    agentKey: UNROUTABLE_KEY,
    expected: undefined,
  },
  {
    name: "dispatch flag on, client allowlisted, key routable → dispatches",
    dispatchEnabled: true,
    clientAllowlisted: true,
    agentKey: ROUTABLE_KEY,
    expected: ROUTABLE_PRODUCT,
  },
] as const;

/** The two fields `withEngineRunFields` appends, and nothing else. */
function engineFieldKeys(profile: { fields: ReadonlyArray<{ key: string }> }): string[] {
  return profile.fields
    .map((field) => field.key)
    .filter((key) => key === "customPrompt" || key === "mediaAssets");
}

describe("the run dialog resolves the engineProductId the submit core resolves", () => {
  for (const row of MATRIX) {
    it(row.name, () => {
      applyFlags(row);

      // WHAT THE SERVER WILL DO with this run, resolved the way
      // submit-custom.ts:548 resolves it.
      const submitCoreProductId = resolveDispatchedAgentEngineProductId(
        row.agentKey,
        CLIENT.agentsRepoSlug,
      );

      // WHAT THE DIALOG WILL PAINT, resolved the way the dialog now gets its
      // answer: the page builds the map with the same function, the dialog
      // looks the pair up in it. Both halves of the real path, not a
      // convention someone has to remember to follow.
      const dispatchMap = buildEngineDispatchMap(
        [CLIENT],
        [row.agentKey],
        resolveDispatchedAgentEngineProductId,
      );
      const dialogProductId = engineProductIdForPair(dispatchMap, CLIENT.id, row.agentKey);

      expect(dialogProductId).toBe(submitCoreProductId);
      expect(dialogProductId).toBe(row.expected);

      // …and therefore the field set. `undefined` leaves the profile untouched,
      // so a client on the legacy path is offered no engine-only field at all.
      const profile = withEngineRunFields(
        launchProfileFor({ key: row.agentKey, name: AGENT.name }),
        dialogProductId,
      );
      expect(engineFieldKeys(profile)).toEqual(
        row.expected === undefined ? [] : ["customPrompt", "mediaAssets"],
      );
    });
  }

  it("is not vacuous: the key-only resolver the dialog used to call disagrees on two of these rows", () => {
    // The guard that makes the matrix mean something. `resolveAgentEngine
    // ProductIdForCustomAgent` is blind to both flags, so it answers
    // "instagram-agent" for rows 1 and 2 — where the run demonstrably goes to
    // agent-service. If the dialog ever goes back to asking it, the rows above
    // fail; this states why, so the next reader does not have to reconstruct it.
    for (const row of MATRIX.filter((r) => r.agentKey === ROUTABLE_KEY && r.expected === undefined)) {
      applyFlags(row);
      expect(resolveAgentEngineProductIdForCustomAgent(row.agentKey)).toBe(ROUTABLE_PRODUCT);
      expect(resolveDispatchedAgentEngineProductId(row.agentKey, CLIENT.agentsRepoSlug)).toBeUndefined();
    }
  });

  it("omits a client with no dispatching agent from the map entirely, rather than writing an empty row", () => {
    // "An entry exists only where it dispatches" is a property of the built
    // map, not only of how it is read — so a caller that iterates it sees the
    // truth too.
    applyFlags({ dispatchEnabled: true, clientAllowlisted: false });
    expect(
      buildEngineDispatchMap([CLIENT], [ROUTABLE_KEY], resolveDispatchedAgentEngineProductId),
    ).toEqual({});
  });
});

describe("what the dialog actually renders for a client on the legacy path", () => {
  function dialogMarkup(engineDispatch: Record<string, Record<string, string>>): string {
    return renderToStaticMarkup(
      <RunCustomAgentModal
        agent={{ ...AGENT }}
        clientId={CLIENT.id}
        engineDispatch={engineDispatch}
        contextItems={[]}
        viewerIsClient
        onClose={() => {}}
      />,
    );
  }

  it("paints both engine-only fields when this pair really dispatches", () => {
    // Positive first: the negatives below would pass against an empty string,
    // and a dialog that stopped rendering would prove nothing.
    const markup = dialogMarkup({ [CLIENT.id]: { [ROUTABLE_KEY]: ROUTABLE_PRODUCT } });
    expect(markup).toContain("Direction for this run");
    expect(markup).toContain("Source media");
  });

  it("paints NEITHER for a client who is not cut over — the T-B5 bug, at its second call site", () => {
    // The empty map is what the page hands down for every client not yet on
    // `AGENT_ENGINE_CUSTOM_AGENT_CLIENTS`. Before T-B21 both fields appeared
    // here, and both answers went to agent-service and vanished.
    const markup = dialogMarkup({});
    expect(markup).not.toContain("Direction for this run");
    expect(markup).not.toContain("Source media");
  });
});

describe("the wire the answer travels on", () => {
  const componentSource = readFileSync(
    resolve(__dirname, "../../../components/custom-agents.tsx"),
    "utf8",
  );
  const detailPageSource = readFileSync(
    resolve(__dirname, "../../../app/(app)/clients/[id]/agents/[agentId]/page.tsx"),
    "utf8",
  );

  it("the dialog no longer imports the key-only resolver at all", () => {
    // The footgun removed rather than merely not called: an import that is not
    // there cannot be reached for by the next person editing this file, which
    // is how the same mistake was made twice.
    expect(componentSource).not.toContain("resolveAgentEngineProductIdForCustomAgent");
  });

  it("the dialog resolves the pair through the server-built map", () => {
    expect(componentSource).toContain(
      "engineProductIdForPair(engineDispatch, selectedClientId, agent.key)",
    );
  });

  it("the page resolves it with the same call the submit core makes", () => {
    // Same function, same argument order, on the surface that has the client
    // record. `submit-custom.ts` is pinned to the identical call shape by
    // submit-custom-engine-dispatch-drift.test.ts.
    expect(detailPageSource).toContain(
      "resolveDispatchedAgentEngineProductId(agent.key, client.agentsRepoSlug)",
    );
    expect(detailPageSource).toContain("engineDispatch={engineDispatch}");
  });

  it("the dialog re-seeds the brief when the selected client changes", () => {
    expect(componentSource).toContain("reseedAgentBrief(current, profile)");
  });
});

describe("reseedAgentBrief — changing client mid-brief keeps the answers, drops the orphans", () => {
  const engineProfile = withEngineRunFields(
    launchProfileFor({ key: ROUTABLE_KEY, name: AGENT.name }),
    ROUTABLE_PRODUCT,
  );
  const legacyProfile = launchProfileFor({ key: ROUTABLE_KEY, name: AGENT.name });

  it("keeps every answer the new profile still declares", () => {
    const typed = { ...initialAgentBrief(engineProfile), request: "the pricing change", audience: "heads of growth" };
    const reseeded = reseedAgentBrief(typed, legacyProfile);
    expect(reseeded.request).toBe("the pricing change");
    expect(reseeded.audience).toBe("heads of growth");
  });

  it("drops an answer to a field the new profile does not have", () => {
    // The silent drop this ticket exists to close, arriving from the other
    // direction: a `customPrompt` typed for a cut-over client, left in
    // `briefValues` after switching to one on the legacy path, is a value
    // nothing paints, nothing can undo, and the submit still carries.
    const typed = { request: "the pricing change", customPrompt: "lean on the counterpoint" };
    expect(reseedAgentBrief(typed, legacyProfile)).not.toHaveProperty("customPrompt");
    // …and it comes back, empty, when the selection moves to a cut-over client.
    expect(reseedAgentBrief(typed, engineProfile).customPrompt).toBe("lean on the counterpoint");
  });

  it("seeds the new profile's defaults for fields the old brief never had", () => {
    const defaults = initialAgentBrief(engineProfile);
    const seededKeys = Object.keys(reseedAgentBrief({}, engineProfile));
    expect(seededKeys).toEqual(Object.keys(defaults));
  });

  it("treats a deliberately cleared answer as an answer, not a missing one", () => {
    const cleared = reseedAgentBrief({ ...initialAgentBrief(engineProfile), run_mode: "" }, engineProfile);
    expect(cleared.run_mode).toBe("");
  });
});
