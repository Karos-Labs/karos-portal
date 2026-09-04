import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, stripComments } from "./source-scan";
import { ACTION_DEFINITIONS } from "../action-list";
import {
  SETUP_STEP_ACTION_IDS,
  agentSetupHref,
  agentSetupStepDone,
  familyHasIntakePage,
  nextSetupStep,
  orderSetupLadderAgents,
  pickSetupLadderAgent,
  rankSetupLadder,
  resolveSetupLadder,
  resolveSetupLadderOrder,
  setupLadderOrderIsStale,
  scoreSetupLadderAgent,
  setupLadderComplete,
  setupLadderFamily,
  setupLadderProgress,
  SETUP_LADDER_HIDDEN_ACTION_ID,
  SETUP_LADDER_WEIGHTS,
  SETUP_STEP_IDS,
  type SetupLadderAgentCandidate,
  type SetupLadderContext,
} from "../setup-ladder";

/**
 * THE SETUP LADDER (portal feedback round 4, 2026-09).
 *
 * Six steps, one per-client agent order, and a completion mapping that reuses
 * the action-list ids the portal already stores. Every rule here is a pure
 * function on purpose — the page resolves the signals (step 3 needs Firestore),
 * this module decides what they mean, and that split is what makes the
 * behaviour testable at all.
 */

/* ─── the six steps and how they complete ─── */

const X_AGENT = "karos-x-agent-v2";
const LINKEDIN_AGENT = "karos-linkedin-writer-v2";
const REDDIT_AGENT = "karos-reddit-agent";
const INSTAGRAM_AGENT = "karos-instagram-tiktok-content-agent";

const AGENT = (over: Partial<SetupLadderAgentCandidate> = {}): SetupLadderAgentCandidate => ({
  id: "a1",
  name: "X agent",
  setupHref: "/clients/c1/x-agent",
  runHref: "/clients/c1/agents/a1",
  selfServe: true,
  setupReady: false,
  live: false,
  ...over,
});

const CTX = (over: Partial<SetupLadderContext> = {}): SetupLadderContext => ({
  profileDone: false,
  profileHref: "/clients/c1/settings?tab=profile",
  brandVoiceDone: false,
  audienceDone: false,
  documentsHref: "/clients/c1/settings?tab=profile#documents",
  agent: null,
  agentsHref: "/clients/c1/agents",
  runDone: false,
  resultDone: false,
  resultHref: "/calendar?view=archive",
  ...over,
});

describe("resolveSetupLadder", () => {
  it("is six steps, in the audit's order, and never more", () => {
    const steps = resolveSetupLadder(CTX());
    expect(steps.map((s) => s.id)).toEqual([...SETUP_STEP_IDS]);
    expect(steps).toHaveLength(6);
  });

  it("ships step 0 already ticked — endowed progress, and it is honest", () => {
    // The client cannot reach Home without having finished the signup wizard
    // (lib/onboarding.ts blocks the whole (app) group until then), so the only
    // reader of this row is someone for whom it is genuinely complete. One of
    // six is 17%, inside Coglode's 10-25% band.
    const steps = resolveSetupLadder(CTX());
    expect(steps[0]?.done).toBe(true);
    expect(setupLadderProgress(steps)).toEqual({ done: 1, total: 6, percent: 17 });
  });

  it("completes the merged voice step only when BOTH documents are done", () => {
    const voice = (c: Partial<SetupLadderContext>) =>
      resolveSetupLadder(CTX(c)).find((s) => s.id === "voice")?.done;
    // Ids 21 and 22 were two rows for one gesture — that is part of why the old
    // list ran to 24 — but merging them must not make either one optional.
    expect(voice({ brandVoiceDone: true, audienceDone: false })).toBe(false);
    expect(voice({ brandVoiceDone: false, audienceDone: true })).toBe(false);
    expect(voice({ brandVoiceDone: true, audienceDone: true })).toBe(true);
  });

  it("maps the other three straight onto their own signal", () => {
    const done = (c: Partial<SetupLadderContext>) =>
      Object.fromEntries(resolveSetupLadder(CTX(c)).map((s) => [s.id, s.done]));
    expect(done({ profileDone: true }).profile).toBe(true);
    expect(done({ runDone: true }).run).toBe(true);
    expect(done({ resultDone: true }).result).toBe(true);
    expect(done({}).profile).toBe(false);
  });

  it("points the agent steps at the picked agent, and at the roster when there is none", () => {
    const withAgent = resolveSetupLadder(CTX({ agent: AGENT() }));
    expect(withAgent.find((s) => s.id === "agent")?.href).toBe("/clients/c1/x-agent");
    expect(withAgent.find((s) => s.id === "run")?.href).toBe("/clients/c1/agents/a1");
    // No grant yet: Karos has not finished this client's setup, so the rows
    // still name a real destination rather than a dead link.
    const without = resolveSetupLadder(CTX());
    expect(without.find((s) => s.id === "agent")?.href).toBe("/clients/c1/agents");
    expect(without.find((s) => s.id === "run")?.href).toBe("/clients/c1/agents");
    expect(without.find((s) => s.id === "agent")?.done).toBe(false);
  });

  it("names the agent in the reason line when it has one", () => {
    const why = (agent: SetupLadderAgentCandidate | null) =>
      resolveSetupLadder(CTX({ agent })).find((s) => s.id === "agent")?.why ?? "";
    expect(why(AGENT({ name: "LinkedIn agent" }))).toContain("LinkedIn agent");
    expect(why(null)).toContain("Your first agent");
  });

  it("says nothing to a client with an em dash in it", () => {
    // The portal's client-facing copy rule. These strings are read by a client
    // on their own Home, so they follow it like every other client sentence.
    for (const step of resolveSetupLadder(CTX({ agent: AGENT() }))) {
      expect(step.label, `${step.id}'s label`).not.toContain("—");
      expect(step.why, `${step.id}'s reason`).not.toContain("—");
    }
  });
});

describe("the step that is waiting on Karos", () => {
  const ENGINE = AGENT({ id: "ig", name: "Instagram agent", selfServe: false, live: false });

  const agentStep = (agent: SetupLadderAgentCandidate | null) =>
    resolveSetupLadder(CTX({ agent })).find((s) => s.id === "agent");

  it("carries no destination, so the row cannot offer a press", () => {
    const step = agentStep(ENGINE);
    expect(step?.waiting).toBe(true);
    expect(step?.href).toBeUndefined();
    expect(step?.done).toBe(false);
  });

  it("says who it is waiting on, in the client's own language", () => {
    const step = agentStep(ENGINE);
    expect(step?.why).toContain("Karos is setting");
    expect(step?.label).not.toContain("—");
    expect(step?.why).not.toContain("—");
  });

  it("hands the ladder's one button to the next step the client CAN reach", () => {
    // The whole point of the split: steps 4 and 5 proceed. Parking the press on
    // a row nobody can press left the two rows below it with no affordance.
    const steps = resolveSetupLadder(
      CTX({ profileDone: true, brandVoiceDone: true, audienceDone: true, agent: ENGINE }),
    );
    expect(nextSetupStep(steps)?.id).toBe("run");
    // …and the ladder is NOT complete, so the finished-card branch stays shut.
    expect(setupLadderComplete(steps)).toBe(false);
  });

  it("is a task again the moment Karos takes the agent live", () => {
    const live = { ...ENGINE, live: true };
    const step = agentStep(live);
    expect(step?.waiting).toBeUndefined();
    expect(step?.done).toBe(true);
    expect(step?.href).toBe(live.setupHref);
  });

  it("never fires for an agent the client has a form for", () => {
    const step = agentStep(AGENT({ selfServe: true, setupReady: false }));
    expect(step?.waiting).toBeUndefined();
    expect(step?.href).toBeTruthy();
  });
});

describe("nextSetupStep / setupLadderComplete", () => {
  it("hands the button to the first step that is not done, and to nothing else", () => {
    // Only ONE row carries the press. Every row stays a legitimate destination
    // (GOV.UK: let people do tasks in any order), but six primary buttons on
    // Home is six things competing for one press.
    const steps = resolveSetupLadder(CTX({ profileDone: true }));
    expect(nextSetupStep(steps)?.id).toBe("voice");
  });

  it("reports completion only when every step is done", () => {
    const partial = resolveSetupLadder(CTX({ profileDone: true }));
    expect(setupLadderComplete(partial)).toBe(false);
    expect(nextSetupStep(partial)).not.toBeNull();
    const all = resolveSetupLadder(
      CTX({
        profileDone: true,
        brandVoiceDone: true,
        audienceDone: true,
        agent: AGENT({ setupReady: true }),
        runDone: true,
        resultDone: true,
      }),
    );
    expect(setupLadderComplete(all)).toBe(true);
    expect(nextSetupStep(all)).toBeNull();
    expect(setupLadderProgress(all)).toEqual({ done: 6, total: 6, percent: 100 });
  });
});

/* ─── step 3: which agent, and when is it set up ─── */

describe("agentSetupStepDone", () => {
  it("asks a self-serve agent about its own intake and stand-up", () => {
    // The exact pair the submit core refuses on, so the ladder and the server
    // cannot disagree about what "ready" means.
    expect(agentSetupStepDone(AGENT({ selfServe: true, setupReady: true }))).toBe(true);
    expect(agentSetupStepDone(AGENT({ selfServe: true, setupReady: false, live: true }))).toBe(
      false,
    );
  });

  it("asks an agent with no self-service path whether Karos took it live", () => {
    // The Instagram/TikTok content engine has no intake form at all, so asking
    // after one would be asking about a page that does not exist.
    expect(agentSetupStepDone(AGENT({ selfServe: false, live: true }))).toBe(true);
    expect(agentSetupStepDone(AGENT({ selfServe: false, live: false, setupReady: true }))).toBe(
      false,
    );
  });
});

describe("pickSetupLadderAgent", () => {
  const a = AGENT({ id: "a", name: "A" });
  const b = AGENT({ id: "b", name: "B" });
  const c = AGENT({ id: "c", name: "C" });

  it("takes the first agent in the client's own order that still needs input", () => {
    expect(pickSetupLadderAgent([a, b, c], ["c", "b", "a"])?.id).toBe("c");
  });

  it("skips the ones already set up", () => {
    const done = { ...c, setupReady: true };
    expect(pickSetupLadderAgent([a, b, done], ["c", "a", "b"])?.id).toBe("a");
  });

  it("prefers an agent the client can actually act on", () => {
    // THE LADDER USED TO GET STUCK (review wave, 2026-09). The Instagram/TikTok
    // content engine has no intake page at all — staff bind it and take it live
    // — so a client whose order opens with it read "Set up your first agent"
    // above a button into a page that asks them for nothing, while the X agent
    // one row down was a form away from a first draft and never got named.
    const engine = AGENT({ id: "ig", name: "Instagram", selfServe: false, live: false });
    const form = AGENT({ id: "x", name: "X", selfServe: true, setupReady: false });
    expect(pickSetupLadderAgent([engine, form], ["ig", "x"])?.id).toBe("x");
    // …and the order still decides between two agents that CAN both be acted on.
    const second = AGENT({ id: "li", name: "LinkedIn", selfServe: true });
    expect(pickSetupLadderAgent([form, second], ["li", "x"])?.id).toBe("li");
  });

  it("still picks the agent nobody can act on when it is the only one left", () => {
    // It is then rendered as a status row rather than a task — see the waiting
    // step below. Skipping it entirely would tell the client step 3 is done.
    const engine = AGENT({ id: "ig", selfServe: false, live: false });
    const done = AGENT({ id: "x", selfServe: true, setupReady: true });
    expect(pickSetupLadderAgent([engine, done], ["x", "ig"])?.id).toBe("ig");
  });

  it("falls back to the first in order once they are all set up", () => {
    // So a finished ladder's rows still point somewhere real.
    const all = [a, b, c].map((x) => ({ ...x, setupReady: true }));
    expect(pickSetupLadderAgent(all, ["b", "a", "c"])?.id).toBe("b");
  });

  it("is null when the client has no granted agent at all", () => {
    expect(pickSetupLadderAgent([], ["a"])).toBeNull();
  });
});

describe("orderSetupLadderAgents", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("drops stored ids the client no longer has, and appends grants added later", () => {
    // The stored array is a PREFERENCE, never a source of truth about what this
    // client has: a grant can be revoked and an agent retired.
    expect(orderSetupLadderAgents(agents, ["gone", "c", "a"]).map((x) => x.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("keeps the caller's order when nothing is stored", () => {
    expect(orderSetupLadderAgents(agents, undefined).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(orderSetupLadderAgents(agents, []).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

/* ─── the stored order, and when it stops describing the client ─── */

describe("setupLadderOrderIsStale", () => {
  const agents = [{ id: "a" }, { id: "b" }];

  it("is stale with nothing stored", () => {
    expect(setupLadderOrderIsStale(agents, undefined)).toBe(true);
    expect(setupLadderOrderIsStale(agents, [])).toBe(true);
  });

  it("is not stale while the stored array still covers every grant", () => {
    expect(setupLadderOrderIsStale(agents, ["b", "a"])).toBe(false);
    // A stored id for an agent that is gone is not staleness — that case is
    // handled by dropping it (orderSetupLadderAgents) and does not change the
    // relative order of what is left.
    expect(setupLadderOrderIsStale(agents, ["b", "gone", "a"])).toBe(false);
  });

  it("is stale when a grant arrived after the order was computed", () => {
    // Otherwise the new agent is APPENDED, so an agent granted later lands at
    // the back of the ladder however strong its evidence is.
    expect(setupLadderOrderIsStale(agents, ["a"])).toBe(true);
  });

  it("reads the grant stamps when the caller has them", () => {
    // The case the id check cannot see: an id that WAS in the stored order,
    // revoked, and granted again under a new plan.
    const orderAt = 1_000;
    const fresh = new Map([["b", 2_000]]);
    expect(setupLadderOrderIsStale(agents, ["a", "b"], { orderAt, grantedAt: fresh })).toBe(true);
    const old = new Map([["b", 500]]);
    expect(setupLadderOrderIsStale(agents, ["a", "b"], { orderAt, grantedAt: old })).toBe(false);
    // No stamp to compare against is not evidence of staleness.
    expect(setupLadderOrderIsStale(agents, ["a", "b"], { grantedAt: fresh })).toBe(false);
  });
});

describe("resolveSetupLadderOrder", () => {
  const agents = [
    { id: "ig", key: INSTAGRAM_AGENT, name: "Instagram agent" },
    { id: "li", key: LINKEDIN_AGENT, name: "LinkedIn agent" },
  ];

  it("keeps a stored order that still describes the client", () => {
    expect(resolveSetupLadderOrder({ agents, storedOrder: ["li", "ig"] })).toEqual(["li", "ig"]);
  });

  it("re-ranks rather than appending when a grant is newer than the order", () => {
    // `setupLadderOrderAt` had no reader at all before this (review wave,
    // 2026-09), so a re-planned client kept walking the order they were
    // onboarded with.
    const resolved = resolveSetupLadderOrder({
      agents,
      storedOrder: ["ig"],
      socialLinks: { linkedin: "in/acme" },
    });
    expect(resolved).toEqual(["li", "ig"]);
  });

  it("computes one from scratch when nothing is stored", () => {
    expect(resolveSetupLadderOrder({ agents })).toEqual(rankSetupLadder({ agents }));
  });
});

/* ─── families and destinations ─── */

describe("setupLadderFamily", () => {
  it("recognises the six intake families through the shared identity predicates", () => {
    expect(setupLadderFamily({ key: X_AGENT })).toBe("x");
    expect(setupLadderFamily({ key: LINKEDIN_AGENT })).toBe("linkedin");
    expect(setupLadderFamily({ key: REDDIT_AGENT })).toBe("reddit");
    for (const family of ["x", "linkedin", "reddit"] as const) {
      expect(familyHasIntakePage(family)).toBe(true);
    }
  });

  it("calls the combined content engine what it is, and gives it no intake page", () => {
    // The one family where a checklist row worded as a client action would lie
    // hardest: staff bind it and take it live, there is no form to fill in.
    expect(setupLadderFamily({ key: INSTAGRAM_AGENT })).toBe("instagram");
    expect(familyHasIntakePage("instagram")).toBe(false);
    expect(agentSetupHref("c1", { id: "a1", key: INSTAGRAM_AGENT })).toBe("/clients/c1/agents/a1");
  });

  it("sends a self-serve agent to its family's own intake page", () => {
    expect(agentSetupHref("c1", { id: "a1", key: X_AGENT })).toBe("/clients/c1/x-agent");
    expect(agentSetupHref("c1", { id: "a2", key: LINKEDIN_AGENT })).toBe(
      "/clients/c1/linkedin-agent",
    );
  });

  it("says nothing about an agent it does not recognise", () => {
    expect(setupLadderFamily({ key: "karos-something-else" })).toBeNull();
    expect(agentSetupHref("c1", { id: "a9", key: "karos-something-else" })).toBe(
      "/clients/c1/agents/a9",
    );
  });
});

/* ─── the deterministic ranking ─── */

describe("rankSetupLadder", () => {
  const agents = [
    { id: "ig", key: INSTAGRAM_AGENT, name: "Instagram agent" },
    { id: "li", key: LINKEDIN_AGENT, name: "LinkedIn agent" },
    { id: "x", key: X_AGENT, name: "X agent" },
  ];

  it("keeps the plan's own order when there is nothing to rank on", () => {
    // customAgentIds order is the tie-break, so a client we know nothing about
    // gets the order Karos granted, except for the stand-up adjustment below.
    expect(rankSetupLadder({ agents: [agents[0]!, agents[1]!] })).toEqual(["ig", "li"]);
  });

  it("puts the platform the client already has a handle on first", () => {
    expect(
      rankSetupLadder({ agents, socialLinks: { linkedin: "in/acme" } }),
    ).toEqual(["li", "x", "ig"]);
  });

  it("stacks a connected channel on top of the handle", () => {
    // X's integration id is the platform's older name; getting that wrong would
    // silently score every X client zero.
    const score = scoreSetupLadderAgent(agents[2]!, {
      socialLinks: { x: "@acme" },
      connectedPlatformIds: ["twitter"],
    });
    expect(score).toBe(
      SETUP_LADDER_WEIGHTS.handle + SETUP_LADDER_WEIGHTS.connected + SETUP_LADDER_WEIGHTS.noStandUp,
    );
  });

  it("counts a Karos pin, and the category table, at their own weights", () => {
    expect(scoreSetupLadderAgent(agents[0]!, { starredAgentIds: ["ig"] })).toBe(
      SETUP_LADDER_WEIGHTS.pinned,
    );
    // "b2b saas" → LinkedIn and X. LinkedIn also pays the stand-up penalty.
    expect(scoreSetupLadderAgent(agents[1]!, { category: "B2B SaaS" })).toBe(
      SETUP_LADDER_WEIGHTS.category + SETUP_LADDER_WEIGHTS.standUp,
    );
    expect(scoreSetupLadderAgent(agents[0]!, { category: "B2B SaaS" })).toBe(0);
  });

  it("prefers the agent that reaches a first draft with no stand-up run in the way", () => {
    // X and Reddit draft straight off their form; LinkedIn, blog, newsletter
    // and reputation each need a one-time stand-up first.
    expect(rankSetupLadder({ agents: [agents[1]!, agents[2]!] })).toEqual(["x", "li"]);
  });

  it("breaks ties by the plan's order, so the same client always gets the same answer", () => {
    // Determinism is what lets Home fall back to computing this on the fly for
    // a client onboarded before the stored field existed.
    const ctx = { agents, category: "restaurant", socialLinks: { instagram: "@acme" } };
    expect(rankSetupLadder(ctx)).toEqual(rankSetupLadder(ctx));
    expect(rankSetupLadder(ctx)[0]).toBe("ig");
  });

  it("returns exactly the ids it was given, and nothing else", () => {
    // The stored array is read back as agent ids: inventing one would point the
    // ladder at an agent this client does not have.
    const ranked = rankSetupLadder({ agents, socialLinks: { linkedin: "in/acme" } });
    expect([...ranked].sort()).toEqual(["ig", "li", "x"]);
  });
});

/* ─── the ids the ladder reuses, and the page that reads them ─── */

describe("SETUP_STEP_ACTION_IDS", () => {
  it("is five existing action-list ids, so no client's stored progress resets", () => {
    // The whole reason the ladder can ship without a ClientActionState
    // migration: it asks the questions the checklist was already storing
    // answers to. A new id here is a client meeting a step they had done.
    expect(SETUP_STEP_ACTION_IDS).toEqual({
      profile: ["01"],
      voice: ["21", "22"],
      run: ["04"],
      result: ["05"],
    });
    const known = new Set(ACTION_DEFINITIONS.map((a) => a.id));
    for (const ids of Object.values(SETUP_STEP_ACTION_IDS)) {
      for (const id of ids) expect(known.has(id), `${id} is not an action-list row`).toBe(true);
    }
  });

  it("is what Home actually reads, and Home reads nothing else for the ladder", () => {
    const home = stripComments(
      readSource(path.resolve(__dirname, "../..", "app/(app)/clients/[id]/page.tsx")),
    );
    const asked = [...home.matchAll(/actionDone\("(\d+)"\)/g)].map((m) => m[1]).sort();
    expect(asked).toEqual(["01", "04", "05", "21", "22"]);
  });
});

/**
 * ── WHAT HOME ACTUALLY WIRES (review wave, 2026-09) ──────────────────────
 *
 * Every rule above is a pure function's, and each can be perfectly right while
 * the page hands it the wrong input — which is exactly what these three
 * findings were. Source-scanned because this page is a server component whose
 * import graph reaches the Admin SDK: it cannot be rendered in a node run, and a
 * mock deep enough to render it would be asserting against the mock.
 */
describe("the page's own wiring of the ladder", () => {
  const home = stripComments(
    readSource(path.resolve(__dirname, "../..", "app/(app)/clients/[id]/page.tsx")),
  );

  it("tells the ladder which agents the client can act on, and which Karos owns", () => {
    // Step 3's whole split rests on these two fields. `selfServe` is asked
    // through the shared family predicate rather than a regex written at the
    // page, and `live` is the umbrella's launch state — the only "set up"
    // answer an agent with no intake page can have.
    expect(home).toContain("selfServe: familyHasIntakePage(setupLadderFamily(agent))");
    expect(home).toMatch(/live: umbrellaByCustomAgentId\.get\(agent\.id\)\?\.launchState === "live"/);
  });

  it("counts runs and outputs the way the CLIENT sees them, on both branches", () => {
    // The ladder ticked "Run your first agent" and "See your first result" off
    // Karos's own stand-up run and its research write-up, before the client had
    // done anything: `jobs.length > 0` and `assets.length > 0` count work the
    // client can neither see nor open.
    expect(home).not.toMatch(/hasRun: jobs\.length/);
    expect(home).not.toMatch(/hasOutput: assets\.length/);
    expect(home).toContain("hasRun: clientVisibleJobs.length > 0");
    expect(home).toContain("hasOutput: clientVisibleAssets.length > 0");
    // The same predicate the run list and the agent-card badge already use.
    expect(home).toMatch(/runType !== "launch" && j\.runType !== "test"/);
    // …and the visible-asset set is the client library's own projection with the
    // locked rows dropped, not a filter invented here.
    expect(home).toContain("getClientLibraryAssets(assets, {");
    expect(home).toContain("clientLibrary.filter((a) => !a.locked)");
  });

  it("computes the client projection once, against one clock", () => {
    // It ran twice with identical arguments, each call taking its own
    // Date.now(), so two lists built from one asset set could disagree about
    // which posts had unlocked.
    expect(home.match(/getClientLibraryAssets\(/g) ?? []).toHaveLength(1);
    expect(home.match(/Date\.now\(\)/g) ?? []).toHaveLength(1);
  });

  it("does not offer staff the client's Hide control", () => {
    // The row is written against the client's account, and whether a client's
    // own onboarding card is on their dashboard is the client's call.
    expect(home).toContain("canHide={isClientViewer}");
  });

  it("hides a finished ladder on a cooldown, and only while it IS finished", () => {
    expect(home).toContain("setupLadderComplete(setupSteps)");
    expect(home).toContain("ACTION_DISMISS_COOLDOWN_MS");
    expect(home).toMatch(/ladderHiddenState\?\.status === "dismissed"/);
  });

  it("reads the stored order through the staleness check", () => {
    expect(home).toContain("resolveSetupLadderOrder({");
    expect(home).toContain("storedOrderAt: client.setupLadderOrderAt");
  });
});

describe("the widget's one write", () => {
  const widget = stripComments(
    readSource(path.resolve(__dirname, "../..", "components/home-get-set-up.tsx")),
  );

  it("is a cooldown, not the portal's one permanent skip", () => {
    // `markActionNotRelevantAction` has no un-mark on the client's side, and
    // this card legitimately comes back: grant a second agent and the ladder
    // reopens with real steps in it (review wave, 2026-09).
    expect(widget).toContain("dismissActionAction(clientId, SETUP_LADDER_HIDDEN_ACTION_ID)");
    expect(widget).not.toContain("markActionNotRelevantAction");
  });

  it("puts the card back and says so when the write fails", () => {
    // Otherwise the card returns on the next navigation with no explanation.
    expect(widget).toMatch(/if \(!res\.ok\)/);
    expect(widget).toContain("setDismissed(false)");
  });

  it("congratulates a client only on a ladder that is really complete", () => {
    // `next === null` was the whole test, and a ladder waiting on Karos has no
    // pressable step left — so it would have read "You are all set up" over an
    // agent nobody had stood up yet.
    expect(widget).toContain("const complete = setupLadderComplete(steps);");
    expect(widget).toMatch(/\{complete \? \(/);
  });
});

describe("the reserved hidden-state id", () => {
  it("is not one of the checklist's own ids", () => {
    // It stores "the client pressed Hide this on the finished ladder", which is
    // a per-client flag rather than a checklist row — no label, no href, no
    // place in any list. action-list-actions.ts allow-lists it by name.
    expect(SETUP_LADDER_HIDDEN_ACTION_ID).toBe("ladder-done");
    expect(SETUP_LADDER_HIDDEN_ACTION_ID).not.toMatch(/^\d\d$/);
  });
});
