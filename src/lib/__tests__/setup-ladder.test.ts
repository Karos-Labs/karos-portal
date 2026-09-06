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

// round 6: the candidate carries the two setup RUNGS separately (so step 3 can
// name the one that is missing) plus the two labels its controls read from.
const AGENT = (over: Partial<SetupLadderAgentCandidate> = {}): SetupLadderAgentCandidate => ({
  id: "a1",
  name: "X agent",
  setupHref: "/clients/c1/x-agent",
  runHref: "/clients/c1/agents/a1",
  selfServe: true,
  setupReady: false,
  hasIntake: false,
  standUpDone: true,
  live: false,
  runLabel: "X post",
  intakeLabel: "X agent details",
  ...over,
});

// round 6: `profileDone` gained the three named fields beside it (decision 2),
// and the merged voice step now asks whether each document EXISTS as well as
// whether it is confirmed (§2.4) — an unwritten document is not an unread one.
const CTX = (over: Partial<SetupLadderContext> = {}): SetupLadderContext => ({
  profileDone: false,
  profileHref: "/clients/c1/settings?tab=profile",
  profile: { category: false, description: false, website: false },
  brandVoice: { present: true, confirmed: false },
  audience: { present: true, confirmed: false },
  agent: null,
  agentsHref: "/clients/c1/agents",
  runDone: false,
  // round 6 review (C4): step 5's signal split into the two facts the page can
  // actually answer — the client OPENED one, or the portal can no longer show
  // them one. `resolveSetupLadder` owns the disjunction.
  resultOpened: false,
  agedOutDeliverable: false,
  resultHref: "/calendar?view=archive",
  // round 6 (alignment fix 1): "the run finished" and "there is something to
  // open" are two facts, so step 5's button is armed by this one and not by
  // `runDone`. The default is the harder case: nothing archived yet.
  resultReady: false,
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
    // round 6: each document is a {present, confirmed} pair now.
    const read = { present: true, confirmed: true };
    const unread = { present: true, confirmed: false };
    expect(voice({ brandVoice: read, audience: unread })).toBe(false);
    expect(voice({ brandVoice: unread, audience: read })).toBe(false);
    expect(voice({ brandVoice: read, audience: read })).toBe(true);
  });

  /* round 6 (§2.4): three states per document, and the row says which. */
  it("names the document that is still waiting, and waits itself while they are missing", () => {
    const voice = (c: Partial<SetupLadderContext>) =>
      resolveSetupLadder(CTX(c)).find((s) => s.id === "voice")!;
    const half = voice({
      brandVoice: { present: true, confirmed: true },
      audience: { present: true, confirmed: false },
    });
    expect(half.why).toBe("Brand Voice confirmed. Your Target Audience is waiting.");
    expect(half.action).toBe("Read your Target Audience");
    expect(half.href).toContain("doc=target-audience");
    // The landing carries the step it came from, and the anchor comes LAST so
    // the two params stay in the query where a search-param reader can see them.
    expect(half.href).toContain("for=voice");
    expect(half.href?.endsWith("#documents")).toBe(true);

    // Nothing written yet: Karos's, so no tick, no button, no destination — the
    // Documents list filters an unwritten document out of itself entirely.
    const missing = voice({
      brandVoice: { present: false, confirmed: false },
      audience: { present: false, confirmed: false },
    });
    expect(missing.waiting).toBe(true);
    expect(missing.href).toBeUndefined();
    expect(missing.action).toBeUndefined();
    // round 6 (alignment fix 3): the row used to promise "Usually ready within
    // the hour". Decision 4's number is for AGENT setup; nobody approved one
    // for the document pipeline, so the row names who is working on it.
    expect(missing.why).toBe(
      "Your Karos team is writing your Brand Voice and Target Audience now.",
    );
    expect(missing.why).not.toContain("within the hour");
  });

  /* round 6 (§2.3, decision 2): three fields, each named. */
  it("names what the profile already has and what it is missing", () => {
    const profile = (fields: { category: boolean; description: boolean; website: boolean }) =>
      resolveSetupLadder(CTX({ profile: fields })).find((s) => s.id === "profile")!;
    const step = profile({ category: true, description: false, website: false });
    expect(step.why).toBe("Your category is set. Add a short description and your website.");
    expect(step.action).toBe("Add a short description");
    expect(step.href).toContain("edit=description");
    expect(step.href).toContain("for=profile");
    // The first missing field is the one the control names, in the definition's
    // own order — so a client with a description but no site is asked for the site.
    expect(profile({ category: true, description: true, website: false }).action).toBe(
      "Add your website",
    );
    expect(profile({ category: false, description: true, website: true }).action).toBe(
      "Add your category",
    );
    // Nothing left to ask for: no control, and the line says so.
    const full = profile({ category: true, description: true, website: true });
    expect(full.action).toBeUndefined();
    expect(full.why).toBe("Your category, description and website are all set.");
  });

  /* round 6 (§2.1): every incomplete row is a destination with a status word. */
  it("gives every incomplete row a link and a status word, and step 0 neither", () => {
    const steps = resolveSetupLadder(CTX({ agent: AGENT() }));
    const byId = new Map(steps.map((s) => [s.id, s]));
    // Step 0 is done and has no href: `/onboarding` is a wizard the (app) shell
    // bounces a finished client straight out of.
    expect(byId.get("workspace")?.href).toBeUndefined();
    for (const id of ["profile", "voice", "agent", "run", "result"] as const) {
      const step = byId.get(id)!;
      expect(step.href, `${id} has no destination`).toBeTruthy();
      expect(step.status ?? step.action, `${id} says nothing on its right`).toBeTruthy();
    }
    expect(byId.get("profile")?.status).toBe("Not started");
  });

  /* round 6 (§2.6/§2.7): a blocked row keeps its link, loses the press. */
  it("says which step a blocked row is waiting for, and never gives it the button", () => {
    const steps = resolveSetupLadder(CTX({ agent: AGENT() }));
    const run = steps.find((s) => s.id === "run")!;
    const result = steps.find((s) => s.id === "result")!;
    expect(run.blocked).toBe(true);
    // round 6 review (C7): ONE-BASED, matching the six rows a client counts
    // from the top. "Set up your first agent" is row 4, not row 3.
    expect(run.status).toBe("After step 4");
    expect(run.action).toBeUndefined();
    expect(run.href).toBeTruthy();
    expect(result.status).toBe("After step 5");
    expect(nextSetupStep(steps)?.id).not.toBe("run");

    // Unblocked, the control names the format the agent's own run panel names.
    const ready = resolveSetupLadder(
      CTX({ agent: AGENT({ hasIntake: true, setupReady: true, runLabel: "Instagram post" }) }),
    );
    const readyRun = ready.find((s) => s.id === "run")!;
    expect(readyRun.blocked).toBeUndefined();
    expect(readyRun.action).toBe("Create your first Instagram post");
    expect(readyRun.href).toBe("/clients/c1/agents/a1#run");
  });

  /**
   * round 6 (alignment fix 1): STEP 5 IS NOT A DEAD END.
   *
   * `runDone` ticks the moment a run reaches the review queue, and what that
   * run produced is a DRAFT — which the client archive excludes by
   * construction. So the accent button "Open your first post" opened an empty
   * Workspace. The step waits on Karos's review instead until the archive holds
   * something, and the button's noun follows the agent's own format.
   */
  it("waits on Karos's review instead of opening an empty archive", () => {
    const result = (over: Partial<SetupLadderContext>) =>
      resolveSetupLadder(
        CTX({ agent: AGENT({ hasIntake: true, setupReady: true }), runDone: true, ...over }),
      ).find((s) => s.id === "result")!;

    const reviewing = result({ resultReady: false });
    expect(reviewing.action).toBeUndefined();
    expect(reviewing.waiting).toBe(true);
    expect(reviewing.why).toBe(
      "Your Karos team is reviewing your first X post. It lands in your Workspace once approved.",
    );
    // A waiting row never takes the accent control, so the ladder cannot point
    // a client at a screen with nothing on it.
    expect(nextSetupStep(resolveSetupLadder(
      CTX({
        profileDone: true,
        brandVoice: { present: true, confirmed: true },
        audience: { present: true, confirmed: true },
        agent: AGENT({ hasIntake: true, setupReady: true }),
        runDone: true,
        resultReady: false,
      }),
    ))).toBeNull();

    // Something archived: the press is back, and it names the format.
    const ready = result({ resultReady: true });
    expect(ready.waiting).toBeUndefined();
    expect(ready.action).toBe("Open your first X post");
    // The noun is the agent's, not "post" for everyone — Reddit drafts a reply.
    expect(
      result({
        resultReady: true,
        agent: AGENT({ hasIntake: true, setupReady: true, runLabel: "reply" }),
      }).action,
    ).toBe("Open your first reply");

    // A ticked row carries neither the wait nor the press, whatever the archive
    // happens to hold.
    const done = result({ resultOpened: true, resultReady: false });
    expect(done.done).toBe(true);
    expect(done.waiting).toBeUndefined();
    expect(done.action).toBeUndefined();
  });

  it("maps the other three straight onto their own signal", () => {
    const done = (c: Partial<SetupLadderContext>) =>
      Object.fromEntries(resolveSetupLadder(CTX(c)).map((s) => [s.id, s.done]));
    expect(done({ profileDone: true }).profile).toBe(true);
    expect(done({ runDone: true }).run).toBe(true);
    expect(done({ resultOpened: true }).result).toBe(true);
    expect(done({}).profile).toBe(false);
  });

  it("points the agent steps at the picked agent, and at the roster when there is none", () => {
    const withAgent = resolveSetupLadder(CTX({ agent: AGENT() }));
    expect(withAgent.find((s) => s.id === "agent")?.href).toBe("/clients/c1/x-agent");
    // round 6 (§2.6): the run row lands ON the run panel, not at the top of the
    // agent's page, which is where the callout it needs is painted.
    expect(withAgent.find((s) => s.id === "run")?.href).toBe("/clients/c1/agents/a1#run");
    // No grant yet: Karos has not finished this client's setup, so the rows
    // still name a real destination rather than a dead link.
    const without = resolveSetupLadder(CTX());
    expect(without.find((s) => s.id === "agent")?.href).toBe("/clients/c1/agents");
    expect(without.find((s) => s.id === "run")?.href).toBe("/clients/c1/agents");
    expect(without.find((s) => s.id === "agent")?.done).toBe(false);
  });

  /* round 6 (§2.5): the two rungs, and the row sends them to the missing one. */
  it("sends a saved intake to the setup hero, not back to a filled form", () => {
    const step = (over: Partial<SetupLadderAgentCandidate>) =>
      resolveSetupLadder(CTX({ agent: AGENT(over) })).find((s) => s.id === "agent")!;
    const noIntake = step({ hasIntake: false });
    expect(noIntake.action).toBe("Add your X agent details");
    expect(noIntake.href).toBe("/clients/c1/x-agent");
    // Form saved, stand-up run missing: the intake page would ask them for
    // nothing they have not already given us.
    const standUpLeft = step({ hasIntake: true, standUpDone: false, setupReady: false });
    expect(standUpLeft.action).toBe("Set up the X agent");
    expect(standUpLeft.href).toBe("/clients/c1/agents/a1#setup");
    expect(standUpLeft.why).toContain("One setup run");
  });

  it("names the agent in the reason line when it has one", () => {
    const why = (agent: SetupLadderAgentCandidate | null) =>
      resolveSetupLadder(CTX({ agent })).find((s) => s.id === "agent")?.why ?? "";
    expect(why(AGENT({ name: "LinkedIn agent" }))).toContain("LinkedIn agent");
    expect(why(null)).toContain("Your first agent");
  });

  /* round 6 (§2.2): one label for six actions was the complaint. */
  it("never gives two rows the same control label", () => {
    const steps = resolveSetupLadder(
      CTX({
        profile: { category: true, description: false, website: false },
        agent: AGENT({ hasIntake: true, setupReady: true }),
        runDone: true,
      }),
    );
    const actions = steps.map((s) => s.action).filter((a): a is string => Boolean(a));
    expect(actions.length).toBeGreaterThan(1);
    expect(new Set(actions).size).toBe(actions.length);
    for (const action of actions) {
      expect(action, "a control label that predicts nothing").not.toMatch(/let'?s do this/i);
    }
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

  // round 6 (§2.9): it carries no PRESS, but it does carry a destination — the
  // agent's own page, which paints the same wait. A row that explains a wait and
  // goes nowhere is the dead end rule 3 forbids.
  it("carries a link to the agent's page but never a press", () => {
    const step = agentStep(ENGINE);
    expect(step?.waiting).toBe(true);
    expect(step?.href).toBe(ENGINE.runHref);
    expect(step?.action).toBeUndefined();
    expect(step?.done).toBe(false);
  });

  it("says who it is waiting on, and by when (decision 4)", () => {
    const step = agentStep(ENGINE);
    expect(step?.why).toBe(
      "Karos is setting up your Instagram agent. Usually ready within 2 business days.",
    );
    expect(step?.label).not.toContain("—");
    expect(step?.why).not.toContain("—");
  });

  // round 6: INVERTED on purpose. This used to hand the press to step 4, on the
  // reasoning that steps 4 and 5 are still the client's to reach — but they are
  // not: without a set-up agent the run panel refuses the run, so the button
  // would open a page that turns it away (the F131 shape). A ladder whose only
  // outstanding work is ours shows no accent control at all, which is the true
  // statement about it.
  it("hands the press to nobody while the outstanding step is ours", () => {
    const read = { present: true, confirmed: true };
    const steps = resolveSetupLadder(
      CTX({ profileDone: true, brandVoice: read, audience: read, agent: ENGINE }),
    );
    expect(nextSetupStep(steps)).toBeNull();
    // round 6 review (C7): one-based.
    expect(steps.find((s) => s.id === "run")?.status).toBe("After step 4");
    // …and the ladder is NOT complete, so the finished-card branch stays shut.
    expect(setupLadderComplete(steps)).toBe(false);
  });

  it("is a task again the moment Karos takes the agent live", () => {
    const live = { ...ENGINE, live: true };
    const step = agentStep(live);
    expect(step?.waiting).toBeUndefined();
    expect(step?.done).toBe(true);
    // round 6: a live agent is set up, so the row points at the agent's page
    // rather than at an intake it does not have.
    expect(step?.href).toBe(live.runHref);
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
        brandVoice: { present: true, confirmed: true },
        audience: { present: true, confirmed: true },
        agent: AGENT({ hasIntake: true, setupReady: true }),
        runDone: true,
        resultOpened: true,
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
    expect(agentSetupStepDone(AGENT({ selfServe: true, setupReady: false, live: false }))).toBe(
      false,
    );
  });

  // round 6 (risk-review B3): EVIDENCE BEATS THE RUNGS, both ways round. This
  // pin used to assert the opposite for a self-serve agent — that a live agent
  // with an unsaved form was not set up — which is the logic bug the brief
  // names from the other end: an agent producing content for this client has
  // provably been set up by somebody, and telling them otherwise on their own
  // Home is the thing Albert walked into.
  it("counts a live agent as set up whatever its rungs say", () => {
    expect(agentSetupStepDone(AGENT({ selfServe: true, setupReady: false, live: true }))).toBe(
      true,
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
    // Step 3's whole split rests on these fields. `selfServe` is asked through
    // the shared family predicate rather than a regex written at the page.
    expect(home).toContain("selfServe: familyHasIntakePage(setupLadderFamily(agent))");
    // round 6 (risk-review B3): `live` was `launchState === "live"` read here,
    // which is the logic bug the brief names — a client receiving pre-created
    // posts every day read "We are setting up your first agent".
    //
    // round 6 review (C1/C3): and B3's fix — a `rosterStatus` call written at
    // this page — was the FOURTH hand assembly of that function's inputs, and it
    // was missing `hasDelivered`, so the same client still read the wrong thing
    // whenever their evidence was a delivered post rather than a live schedule.
    // The ladder reads the ENTRIES the one assembler returns, which is the same
    // call the roster and Reporting read, so this page holds no opinion of its
    // own about the word.
    expect(home).not.toMatch(/live: umbrellaByCustomAgentId\.get\(agent\.id\)\?\.launchState/);
    expect(home, "the ladder may not assemble rosterStatus itself").not.toContain(
      "rosterStatus(",
    );
    expect(home).toContain("await buildClientRosterEntries({");
    expect(home).toContain('live: rosterByAgentId.get(agent.id)?.status.tone === "live"');
    // Ruling 8: no new reads. Every input is already in the page's Promise.all,
    // and the intake reads `buildAgentSetup` makes are handed over as a cache
    // rather than made twice.
    expect(home).toContain("agentSetup,");
    // The row facts (last made, next day) have no reader on this page.
    expect(home).toContain("withRowFacts: false");
    // The two rungs travel separately, so the row can name the missing one.
    expect(home).toContain("hasIntake: Boolean(setup?.ready)");
    expect(home).toContain("standUpDone: Boolean(setup?.standUpDone)");
  });

  it("counts runs and outputs the way the CLIENT sees them, on both branches", () => {
    // The ladder ticked "Run your first agent" and "See your first result" off
    // Karos's own stand-up run and its research write-up, before the client had
    // done anything: `jobs.length > 0` and `assets.length > 0` count work the
    // client can neither see nor open.
    expect(home).not.toMatch(/hasRun: jobs\.length/);
    // round 6 (§2.6): "a run exists" counted a FAILED run, so the step ticked
    // for a client who pressed the button and got nothing. One such job has to
    // have REACHED review, approved or delivered.
    expect(home).not.toContain("hasRun: clientVisibleJobs.length > 0");
    expect(home).toContain("hasRun: producedJobs.length > 0");
    expect(home).toContain('RUN_PRODUCED = new Set(["review", "approved", "delivered"])');
    // round 6 (decision 8): 05 is event-tracked — the client OPENED one — so the
    // "an output exists" proxy is gone from the signals entirely.
    expect(home).not.toMatch(/hasOutput:/);
    // The same predicate the run list and the agent-card badge already use.
    expect(home).toMatch(/runType !== "launch" && j\.runType !== "test"/);
    // …and the visible-asset set is the client library's own projection with the
    // locked rows dropped, not a filter invented here.
    expect(home).toContain("getClientLibraryAssets(assets, {");
    expect(home).toContain("clientLibrary.filter((a) => !a.locked)");
  });

  /* round 6 (decision 2 / §2.4 / decision 8): the three new inputs. */
  it("hands the ladder the three profile fields, both document states and the newest archived item", () => {
    expect(home).toContain("profile: profileFields");
    expect(home).toContain('hasReadableClientDoc(contextDocs, "brand-voice")');
    expect(home).toContain('hasReadableClientDoc(contextDocs, "target-audience")');
    // The last step opens ONE deliverable, and it is one the archive can show:
    // the archive drops drafts, future-dated posts and anything past 30 days.
    expect(home).toContain("getClientArchiveAssets(assets, {");
    expect(home).toContain("&asset=${newestArchived.id}");
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

  // round 6 (decision 9): INVERTED. The stored row was read through the
  // checklist's seven-day cooldown, so a FINISHED ladder came back every week —
  // a card that says "You're set up" reappearing on a dashboard with nothing
  // left to do on it. The press is "Done", and done is not a snooze.
  //
  // round 6 review (C6): TWO CONDITIONS, and both are about the finished card.
  // The cooldown is gone (decision 9: a finished ladder must not come back every
  // week on a seven-day snooze) and the completeness conjunct is BACK — dropping
  // it hid the card for good, so a client granted a second agent was never told
  // there were steps waiting for it. Decision 9 said the slot stays empty after
  // COMPLETION, not that an incomplete ladder stays hidden.
  it("hides a finished ladder, and shows it again when the ladder reopens", () => {
    const hiddenBlock = home.slice(
      home.indexOf("const ladderHiddenState ="),
      home.indexOf("const getSetUpWidget"),
    );
    expect(hiddenBlock).toMatch(/ladderHiddenState\?\.status === "dismissed"/);
    expect(hiddenBlock).toMatch(/ladderHiddenState\?\.status === "not_relevant"/);
    expect(hiddenBlock, "the finished card is still on a cooldown").not.toContain(
      "ACTION_DISMISS_COOLDOWN_MS",
    );
    expect(hiddenBlock).toContain("ladderDismissed && setupLadderComplete(setupSteps)");
  });

  // round 6 review (C4/C5): NOT A GRANDFATHER DATE ANY MORE.
  //
  // Action 05 is an event nobody recorded before the release. The first answer
  // was a fixed timestamp — a fact about OUR release, which ticked the step for
  // clients who had never opened anything and went stale the moment the date
  // passed. The rule now asks the CLIENT'S archive: a posted deliverable older
  // than the archive window is one the portal cannot show them, so the step
  // cannot be asked. It never goes stale and it never ticks on our timeline.
  it("ticks step 5 for work the portal can no longer show, not for work that predates a date", () => {
    expect(home).toContain('resultOpened: actionDone("05")');
    expect(home).toContain("agedOutDeliverable,");
    expect(home).not.toContain("RESULT_STEP_LEGACY_BEFORE");
    expect(home).toContain("clientVisibleAssets.some(");
    expect(home).toMatch(
      /a\.status === "published" && clientDeliveryStamp\(a\) < now - CLIENT_ARCHIVE_WINDOW_MS/,
    );
    // No second read and no second clock: it reuses the projection the page
    // already computed for the overview.
    expect(home.match(/getClientLibraryAssets\(/g) ?? []).toHaveLength(1);
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

/**
 * round 6 review (C4/C5): STEP 5'S TWO HALVES, AND THE ONE CASE THE WAITING ROW
 * IS FOR.
 *
 * Action 05 is an EVENT — the client opened a deliverable — so the step needs a
 * second answer for the work nobody was ever asked to open. The first attempt
 * was a fixed grandfather date, which is a fact about our release timeline: it
 * ticked the step for clients who had never opened anything, and once the date
 * passed it stopped covering anyone, leaving a client with one three-month-old
 * post permanently told to "open what came back" from a Workspace that no longer
 * lists it.
 */
describe("step 5: opened, or aged out of the archive", () => {
  const stood = () => AGENT({ hasIntake: true, setupReady: true });
  const result = (over: Partial<SetupLadderContext>) =>
    resolveSetupLadder(CTX({ agent: stood(), runDone: true, ...over })).find(
      (s) => s.id === "result",
    )!;

  it("ticks on the client having opened one", () => {
    expect(result({ resultOpened: true }).done).toBe(true);
  });

  it("ticks on a deliverable the portal can no longer show them", () => {
    const step = result({ resultOpened: false, agedOutDeliverable: true, resultReady: false });
    expect(step.done).toBe(true);
    // A ticked row takes neither the press nor the wait.
    expect(step.action).toBeUndefined();
    expect(step.waiting).toBeUndefined();
  });

  it("shows the review wait ONLY in the genuine in-review case", () => {
    // `runDone`, the archive holds nothing, and nothing aged out of it either.
    // That is the one state where "we are reviewing your first post" is true.
    const reviewing = result({
      resultOpened: false,
      agedOutDeliverable: false,
      resultReady: false,
    });
    expect(reviewing.waiting).toBe(true);
    expect(reviewing.why).toContain("is reviewing your first");

    // With something aged out, the same empty archive is NOT a review queue —
    // it is a window that has closed — so the row must not invent one.
    const aged = result({ resultOpened: false, agedOutDeliverable: true, resultReady: false });
    expect(aged.waiting).toBeUndefined();
    expect(aged.why).not.toContain("is reviewing your first");
  });

  it("does not tick before a run has produced anything", () => {
    // The aged-out half cannot be true for a client with no deliverables, but
    // the blocked row is what a fresh client sees and it stays blocked.
    const fresh = resolveSetupLadder(CTX({ agent: stood() })).find((s) => s.id === "result")!;
    expect(fresh.done).toBe(false);
    expect(fresh.blocked).toBe(true);
  });
});

/**
 * round 6 review (E7): the row SHAPE is the resolver's answer, not a ternary in
 * the widget. Five kinds, and every row gets exactly one.
 */
describe("SetupStepView.kind", () => {
  it("stamps one kind per row, and current is whatever nextSetupStep picks", () => {
    const steps = resolveSetupLadder(CTX({ agent: AGENT() }));
    const byId = new Map(steps.map((s) => [s.id, s]));
    expect(byId.get("workspace")?.kind).toBe("done");
    // Profile is the first row the client can act on.
    expect(byId.get("profile")?.kind).toBe("current");
    expect(nextSetupStep(steps)?.id).toBe("profile");
    // Its prerequisite is unmet, so the run row is blocked, and step 5 with it.
    expect(byId.get("run")?.kind).toBe("blocked");
    expect(byId.get("result")?.kind).toBe("blocked");
    // Voice is outstanding, the client's, and not their current step.
    expect(byId.get("voice")?.kind).toBe("link");
  });

  it("calls a Karos-owned row waiting, never current", () => {
    const steps = resolveSetupLadder(
      CTX({ brandVoice: { present: false, confirmed: false }, agent: AGENT() }),
    );
    const voice = steps.find((s) => s.id === "voice")!;
    expect(voice.kind).toBe("waiting");
    expect(voice.waiting).toBe(true);
    expect(nextSetupStep(steps)?.id).not.toBe("voice");
  });

  it("never marks a done row current, even when it is the only pressable one", () => {
    const steps = resolveSetupLadder(
      CTX({
        profileDone: true,
        brandVoice: { present: true, confirmed: true },
        audience: { present: true, confirmed: true },
        agent: AGENT({ hasIntake: true, setupReady: true }),
        runDone: true,
        resultOpened: true,
      }),
    );
    expect(steps.every((s) => s.kind === "done")).toBe(true);
  });
});
