import "server-only";

/**
 * Reputation v2 run-time context: the client's stored intake and the seven data
 * files setup emits, serialized to storage and attached to the run as
 * `context_files`.
 *
 * ── THE SAME EPHEMERAL-WORKSPACE PROBLEM, WITH TWO NEW STAKES ─────────────
 *
 * The runner clones the lab repo fresh and the container is destroyed, so
 * anything written under `clients/<slug>/skills/reputation-agent-v2/` is
 * discarded. Four families before this one lost a memory; this one loses two
 * things a client can be harmed by:
 *
 *  - THE RESPONSE LEDGER is the no-repeat memory. Lose it and the next pulse
 *    drafts a second public reply to a review a human already answered, under
 *    the client's own name, on a page strangers read.
 *  - THE CRISIS LEDGER is the audit trail of what was escalated and to whom, on
 *    the only class of event here that has a same-day cost.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * NO BRAND FILE and no CONTENT-FOUNDATION. Unlike the newsletter and the blog,
 * this product does not write marketing copy — it writes replies in the voice
 * `response-voice.md` defines, which is its own file with its own writer. Pulling
 * in the editorial brain would hand a review responder a keyword-target list.
 */

import { randomUUID } from "crypto";
import { getAgentIntake, getClient, listReputationAgentState } from "@/lib/data";
import { resolveDispatchedAgentEngineProductId } from "@/lib/agent-engine/health";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { AgentIntake, ReputationAgentState } from "@/lib/types";
import {
  REPUTATION_RUNNER_KEY,
  REPUTATION_SETUP_KEY,
} from "@/lib/custom-agent-launch";

/**
 * Every reputation skill still in the product. The runner is the agent; setup
 * is its step and is hidden from rosters by `parentKey`.
 *
 * Both are fed the same context, and setup is the reason it is worth saying:
 * setup is the job that CREATES these files, so on a re-run it needs to see
 * what already exists rather than re-seeding a response ledger that records
 * every review already answered.
 *
 * The standalone monthly-review manager (`karos-reputation-manager`) was
 * retired 2026-08-29 (SCRUM-377/T-B25a) — removed from code and the db, do
 * not reintroduce. It used to answer true here too; every caller of this
 * predicate needs nothing further, since no job can carry that key any more.
 */
export function isReputationAgent(agentKey: string): boolean {
  return agentKey === REPUTATION_RUNNER_KEY || agentKey === REPUTATION_SETUP_KEY;
}

/** The SETUP skill specifically — the only one that runs before state exists. */
export function isReputationSetupV2(agentKey: string): boolean {
  return agentKey === REPUTATION_SETUP_KEY;
}

/**
 * Whether the client's reputation intake is saved.
 *
 * Gated on the company row exactly like the other four families, and for the
 * same deliberate portal policy: saving the form with empty answers satisfies
 * it, because the run dialog renders the form inline and pressing Run the first
 * time IS the form. Reputation never has a seat row: a review is about the
 * business, so `seatId: null` is the only shape.
 */
export function hasReputationAgentIntake(clientId: string): Promise<boolean> {
  return getAgentIntake(clientId, "reputation", null).then((row) => row !== null);
}

/**
 * Whether setup is something the ENGINE does for this client on the run itself,
 * so the portal must not ask for it.
 *
 * agent-engine's `reputation-agent` runs a `00-roster-setup` pre-flight
 * (`agents/reputation-agent/src/workflow/roster-setup.ts`): a client with no
 * roster on file has one resolved from the intake the run carries and recorded
 * in client config, then the pulse continues. So for a client whose reputation
 * agent routes to the engine there is no stand-up step to press, no
 * `reputationAgentState` roster row to wait for, and nothing to tell them —
 * the first run simply works or says which named surface could not be
 * resolved. `hasReputationV2Setup` below stays the truth for the legacy path
 * only, and the two are asked together wherever the portal decides "ready".
 *
 * Resolved through the same three-part gate the submit core uses
 * (`resolveDispatchedAgentEngineProductId`: dispatch flag, client allowlist,
 * agent map), so a card can never call setup "handled" for a client whose run
 * would in fact go nowhere.
 */
export async function isReputationSetupInlinedForClient(
  clientId: string,
  agentKey: string = REPUTATION_RUNNER_KEY,
): Promise<boolean> {
  const client = await getClient(clientId);
  return resolveDispatchedAgentEngineProductId(agentKey, client?.agentsRepoSlug) !== undefined;
}

/**
 * The reputation intake as the ENGINE's run input — the keys
 * `00-roster-setup` reads (`ROSTER_SETUP_INPUT_KEYS` in
 * `agents/reputation-agent/src/workflow/roster-setup.ts`; the two sides agree
 * on spelling here and nowhere else).
 *
 * Only what is filled travels: an absent key means "the client said nothing",
 * which the pre-flight reports as such, while an empty array would read as a
 * client who named zero surfaces on purpose. The surfaces are the SEED the
 * engine resolves into real listings; the no-gos become the never-say locks
 * when the client has none on file; markets, crisis routing and context are
 * recorded as provenance with the roster.
 */
export function toReputationEngineRunInput(intake: AgentIntake | null): Record<string, unknown> {
  if (!intake) return {};
  const list = (values: string[] | undefined) => (values ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
  const text = (value: string | undefined) => (value && value.trim().length > 0 ? value.trim() : undefined);
  const surfaces = list(intake.reviewSurfaces);
  const markets = list(intake.reviewMarkets);
  const noGos = list(intake.responseNoGos);
  const crisisRouting = text(intake.crisisRoutingTag);
  const context = text(intake.reputationContext);
  return {
    ...(surfaces.length > 0 ? { reviewSurfaces: surfaces } : {}),
    ...(markets.length > 0 ? { reviewMarkets: markets } : {}),
    ...(noGos.length > 0 ? { responseNoGos: noGos } : {}),
    ...(crisisRouting ? { crisisRoutingTag: crisisRouting } : {}),
    ...(context ? { reputationContext: context } : {}),
  };
}

/**
 * Whether this client has been through setup, i.e. whether the runner has
 * anything to work from.
 *
 * ASKED OF THE ROSTER, and the choice matters. Of the seven files, the roster is
 * the one the runner cannot proceed without: it names the real listings per
 * surface and market, and a pulse with no roster has nowhere to read. It is also
 * the file setup exists to produce — a client's Google Business Profile may be
 * under a trading name and their Yelp listings may be duplicated by a merge, and
 * resolving that is the work.
 *
 * NOT the response ledger, which is legitimately EMPTY for a set-up client who
 * has never had a pulse. Gating on that would refuse every first run.
 */
export async function hasReputationV2Setup(clientId: string): Promise<boolean> {
  const state = await listReputationAgentState(clientId);
  return state.some((row) => row.kind === "roster" && row.content.trim().length > 0);
}

/* ─────────────────── how each state file is re-attached ─────────────────── */

const STATE_FILES: Record<
  ReputationAgentState["kind"],
  { name: string; contentType: string; description: string }
> = {
  facts: {
    name: "01-facts.md",
    contentType: "text/markdown",
    description:
      "What setup established about this business: what it sells, where, and to whom. Background for judging whether a complaint is fair and whether a reply can safely say anything specific. Not a script.",
  },
  config: {
    name: "02-config.json",
    contentType: "application/json",
    description:
      "The surfaces this client is monitored on and the cadence settled at setup. THIS IS THE LIVE COPY; the baked repo's is stale. Deliver it back if the run changes it.",
  },
  autonomy: {
    name: "03-autonomy.json",
    contentType: "application/json",
    description:
      "THE BOUNDS. What this agent may do unattended, what it must escalate to a person, and what it may never touch. Read it BEFORE drafting anything: it is the difference between a reply that goes out and an incident. When it and any other file disagree about what is allowed, THIS FILE WINS and you say so in the run record.",
  },
  roster: {
    name: "roster.json",
    contentType: "application/json",
    description:
      "The client's REAL listings per surface and market, resolved at setup, and the portal's copy is the live one. A listing is not a guess: a business may hold a Google Business Profile under a trading name and duplicate Yelp entries from a merge. Read only the surfaces named here, and never invent one.",
  },
  "response-voice": {
    name: "response-voice.md",
    contentType: "text/markdown",
    description:
      "How a reply from this client should sound, plus the manager's learning log appended beneath it — what a human edited before sending, which is the sharpest voice signal this product gets. Match it. Do not re-derive it during a pulse.",
  },
  "response-ledger": {
    name: "response-ledger.json",
    contentType: "application/json",
    description:
      "THE NO-REPEAT MEMORY, and the portal's copy is the live one. Every review already answered. Check it BEFORE drafting: answering a review a second time posts a duplicate public reply under the client's own name, which is the single worst thing this product can do. Append what you answer and deliver the WHOLE updated file back.",
  },
  "crisis-ledger": {
    name: "crisis-ledger.jsonl",
    contentType: "application/x-ndjson",
    description:
      "One JSON object per line: what was escalated, when, and to whom. The audit trail on the only events here with a same-day cost, and the record that stops the same incident being escalated twice. Append your own rows and deliver the WHOLE file back — the portal stores it as one blob and never merges, so a truncated delivery loses history.",
  },
};

/* ────────────────────────── the client's own answers ────────────────────── */

function intakeMd(intake: AgentIntake | null): string {
  const lines: string[] = [
    "# Reputation agent - the portal's live client data",
    "",
    "SOURCE OF TRUTH for what the CLIENT told us. It overrides any older copy in",
    "the baked repo on any disagreement.",
    "",
    "The roster proper, the response voice, the autonomy bounds and the recurring",
    "complaint themes are all BUILT by setup and live in the attached data files.",
    "They are never collected from the client and must never be asked of them.",
    "What is here is only what setup could not discover.",
    "",
  ];
  if (!intake) {
    lines.push("## No intake stored yet", "- The client has not filled the reputation form.");
    return lines.join("\n");
  }

  const list = (values: string[] | undefined) =>
    (values ?? []).map((v) => v.trim()).filter(Boolean);

  lines.push("## Where they think they are reviewed");
  const surfaces = list(intake.reviewSurfaces);
  lines.push(
    surfaces.length > 0
      ? `${surfaces.map((s) => `  - ${s}`).join("\n")}\n\n  A SEED, not the roster. Setup resolves these to real listings; a client\n  naming three sites may hold five listings or one.`
      : "- Nothing named. Find their listings from the business facts alone, and say in the run record that the client named none.",
  );

  const markets = list(intake.reviewMarkets);
  if (markets.length > 0) {
    lines.push(
      "",
      "## Locations or markets",
      ...markets.map((m) => `  - ${m}`),
      "",
      "  Keep one branch's complaints out of another branch's report.",
    );
  }

  lines.push("", "## Standing context");
  lines.push(
    intake.reputationContext?.trim()
      ? `${intake.reputationContext.trim()}\n\n  BACKGROUND, never a subject to write about. A responder needs to know it\n  before writing; a reply must not raise it unprompted.`
      : "- None on file.",
  );

  lines.push("", "## Who a crisis goes to");
  // The one field with a same-day consequence, and the only one whose ABSENCE is
  // worth spelling out to the run: a flag nobody is told about is a flag that
  // waits for whenever the client next opens the portal.
  lines.push(
    intake.crisisRoutingTag?.trim()
      ? `- ${intake.crisisRoutingTag.trim()}\n\n  Name this contact in about.txt on any run that flags something urgent, so the\n  person who opens the deliverable knows who has to see it and does not have to\n  work it out.`
      : "- NOBODY NAMED. The client has not said who handles an urgent review.\n  Still flag it, and say plainly in about.txt that no contact is on file so it\n  is escalated by whoever reads this. Do not guess at a name or an inbox.",
  );

  lines.push("", "## Never claim in a public reply");
  const noGos = list(intake.responseNoGos);
  lines.push(
    noGos.length > 0
      ? `${noGos.map((n) => `  - ${n}`).join("\n")}\n\n  REFUSE a draft that needs one of these rather than writing around it. A reply\n  that dodges the client's own rule reads as evasive in public, which is worse\n  than no reply.`
      : "- None on file beyond the house rules and the autonomy bounds.",
  );
  return lines.join("\n");
}

async function upload(
  clientId: string,
  runKey: string,
  name: string,
  body: string,
  contentType: string,
) {
  const { url } = await uploadBytes({
    bytes: Buffer.from(body, "utf8"),
    path: `clients/${clientId}/reputation-agent/portal-context/${runKey}/${name}`,
    contentType,
  });
  return url;
}

/**
 * Build the reputation agent's portal-data context files for one run. Returns []
 * when there is nothing at all to say, so callers can append unconditionally.
 *
 * SETUP GETS THE STATE TOO, which is not an oversight. Setup is re-runnable, and
 * a re-run must VERIFY rather than re-seed — above all it must not re-seed a
 * response ledger that already records answered reviews, because an empty ledger
 * is what makes the next pulse answer them again.
 */
export async function buildReputationAgentContextFiles(
  clientId: string,
  agentName?: string,
): Promise<AgentServiceContextFile[]> {
  const [intake, state] = await Promise.all([
    getAgentIntake(clientId, "reputation", null),
    listReputationAgentState(clientId),
  ]);
  if (!intake && state.length === 0) return [];

  const files: AgentServiceContextFile[] = [];
  const runKey = randomUUID();

  files.push({
    name: "reputation-portal-intake.md",
    url: await upload(
      clientId,
      runKey,
      "reputation-portal-intake.md",
      intakeMd(intake),
      "text/markdown",
    ),
    content_type: "text/markdown",
    description:
      "The portal's live reputation intake: the surfaces the client believes they are reviewed on, their locations, any standing context a responder must know, WHO an urgent review is routed to, and the claims they may never make in a public reply. Overrides older copies in the repo.",
  });

  for (const row of state) {
    const spec = STATE_FILES[row.kind];
    if (!spec || !row.content.trim()) continue;
    files.push({
      name: spec.name,
      url: await upload(clientId, runKey, spec.name, row.content, spec.contentType),
      content_type: spec.contentType,
      description: `${spec.description} (Portal copy, captured ${row.contentDate} from run ${row.capturedFromJobId}, version ${row.version}.)`,
    });
  }

  // Named so the run cannot mistake absence for emptiness. An absent ROSTER means
  // setup has not run; an absent LEDGER on a rostered client is a first pulse,
  // which is normal. The two need opposite reactions, so they get separate notes.
  if (agentName && !state.some((r) => r.kind === "roster")) {
    files.push({
      name: "reputation-state-absent.md",
      url: await upload(
        clientId,
        runKey,
        "reputation-state-absent.md",
        [
          "# No reputation state has been captured for this client yet",
          "",
          "There is no roster, so SETUP HAS NOT RUN (or its output was never",
          "captured). There is nowhere to read reviews from.",
          "",
          "Do not guess at listings from the business name. A wrong listing means",
          "drafting replies to another business's customers. Report blocked_intake",
          "naming the missing setup.",
        ].join("\n"),
        "text/markdown",
      ),
      content_type: "text/markdown",
      description:
        "Marks that no roster exists yet - setup has not run. Do not infer listings from the business name; a wrong listing means answering another business's reviews.",
    });
  } else if (agentName && !state.some((r) => r.kind === "response-ledger")) {
    files.push({
      name: "reputation-ledger-absent.md",
      url: await upload(
        clientId,
        runKey,
        "reputation-ledger-absent.md",
        [
          "# No response ledger yet",
          "",
          "This client is set up (a roster exists) but has never had a pulse, so",
          "nothing has been answered. THIS IS NORMAL for a first run and is not a",
          "reason to stop.",
          "",
          "Start the ledger: every review you draft a reply to goes in it, and",
          "deliver the whole file back. From the next pulse on, it is what stops a",
          "review being answered twice.",
        ].join("\n"),
        "text/markdown",
      ),
      content_type: "text/markdown",
      description:
        "Marks a set-up client's FIRST pulse: no reviews have been answered yet. Normal, not a blocker. Start the ledger and deliver it back.",
    });
  }

  return files;
}
