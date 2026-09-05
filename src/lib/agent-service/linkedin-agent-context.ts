import "server-only";

/**
 * LinkedIn agent run-time context: serializes everything the portal holds for a
 * client into files uploaded to storage and attached to the run as
 * `context_files`. Same injection path the X agent (e13) uses. Purely additive —
 * an agent that is not a LinkedIn agent never reaches this module.
 *
 * ── WHAT CHANGED FOR v2, AND WHY THIS FILE CARRIES THE WEIGHT ──────────────
 *
 * The LinkedIn product is now three skills, not one (`products/building/
 * linkedin-agent-v2/`): a run-once SETUP, an on-demand WRITER (one identity, one
 * post per click by default), and an on-demand MANAGER (the only one that goes
 * online — it refills the topic pool and writes the plan the writer reads).
 *
 * Every one of those skills is written against FILES THAT PERSIST between runs:
 * the writer appends a ledger row per delivered post and flips `used_by` on the
 * catalog row it consumed; the manager is the sole author of `AGENT-MEMORY.md`,
 * and its `05-plan.json` is the standing plan every later writer run reads. The
 * runner workspace is baked from GitHub and destroyed, so all of those writes
 * are discarded — which would leave the manager steering nothing and the ledger
 * permanently empty, the exact v1 failure v2 was built to fix (see the lab's
 * `references/run-protocol.md` §12).
 *
 * So the portal is the durable store. Each run's state artifacts are captured
 * off its delivery into `liAgentState` (see the webhook) and re-attached here as
 * the files the skills expect to find. Nothing else makes v2 coherent through
 * this portal.
 *
 * ── ONE COMBINED IDENTITY FILE (Ben, 2026-08-04) ───────────────────────────
 *
 * The lab contract pins one file per identity — `linkedin-voice-card-<id>.json`,
 * `linkedin-learning-log-<id>.md` — and tells the writer to never infer a
 * location. The portal deliberately injects ONE file carrying the company AND
 * every seat instead, on the reasoning that a seat belongs to the company and
 * needs the company's context to write in: "if on the first run you create a
 * file during set up for company, for the seat creation, you add to that file,
 * not create a new one."
 *
 * That override is only safe because the agent instructions state it (see
 * `docs/linkedin-agent-portal.md`): the combined file's sections ARE each
 * identity's voice card and learning log. Without that line a seat run would
 * look for a per-identity path, not find it, and honestly report
 * `blocked_intake` — the file layout and the instructions are one change.
 *
 * ── WHAT STAYS SHARED WITH THE X AGENT, AND WHAT NEVER IS ──────────────────
 *
 * Shared, both by documented rule: the `clientSeats` person record (one person
 * has one seat across every agent) and the "what happened this week" news box
 * (SCRUM-51 — one client input, fanned into both agents' own file shapes).
 * Never shared: voice cards (`seatVoiceProfiles` is keyed by agent), intake
 * (`agentIntake` likewise), feedback (`liDraftFeedback` is its own collection),
 * direction requests, and every row of `liAgentState`. Nothing this module
 * writes or reads can reach an X run.
 */

import { randomUUID } from "crypto";
import {
  getAgentIntake,
  getAsset,
  listAgentIntake,
  listClientSeats,
  listCustomAgents,
  listJobs,
  listLiAgentState,
  listLiDirectionRequests,
  listLiDraftFeedback,
  listSeatVoiceProfiles,
  listXNewsUpdates,
} from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type {
  AgentIntake,
  ClientSeat,
  LiAgentState,
  LiDirectionRequest,
  LiDraftFeedback,
  SeatVoiceProfile,
  XNewsUpdate,
} from "@/lib/types";

/* ───────────────────────────── which agent is this ───────────────────────── */

/** The v2 writer: one identity per run, one post per click by default. */
export const LINKEDIN_WRITER_V2_KEY = "karos-linkedin-writer-v2";
/** The v2 run-once setup, also used per seat (see `LiRunIdentity`). */
export const LINKEDIN_SETUP_V2_KEY = "karos-linkedin-setup-v2";

/**
 * The standalone staff-facing manager card (`karos-linkedin-manager-v2`) was
 * retired 2026-08-29 (SCRUM-377/T-B25a) — removed from code and the db, do
 * not reintroduce. `LINKEDIN_MANAGER_V2_KEY` and `isLinkedInManagerV2` used to
 * live here.
 *
 * THE MANAGER SKILL ITSELF IS UNAFFECTED. It is a subfolder of the writer's
 * own entry directory and still runs automatically as part of every writer
 * press (Ben, 2026-08-04: "Run every run"); only the separate standalone doc
 * that let staff fire it on its own, outside a normal writer press, is gone.
 */
const V2_KEYS: ReadonlySet<string> = new Set([LINKEDIN_WRITER_V2_KEY, LINKEDIN_SETUP_V2_KEY]);

export function isLinkedInWriterV2(agentKey: string): boolean {
  return agentKey === LINKEDIN_WRITER_V2_KEY;
}

export function isLinkedInSetupV2(agentKey: string): boolean {
  return agentKey === LINKEDIN_SETUP_V2_KEY;
}

export function isLinkedInV2Agent(agentKey: string): boolean {
  return V2_KEYS.has(agentKey);
}

/**
 * Every LinkedIn agent in `customAgents`: the three v2 skills, plus the e10
 * generation — the per-client company-page instances
 * (`karos-linkedin-company-<slug>`) and the Path-B master — which stay
 * importable and disabled as the fallback rather than being deleted.
 *
 * Client-safe twin: `isLinkedInAgentIdentity` in custom-agent-launch.ts. If you
 * widen one, widen the other in the same change: this one decides whether the
 * portal's data is injected and the run gate applies, and that one decides
 * whether the card offers the right brief. They disagreeing means either an
 * ungated run or an un-fed one.
 */
export function isLinkedInAgent(agentKey: string): boolean {
  return (
    isLinkedInV2Agent(agentKey) ||
    agentKey === "karos-linkedin-agent" ||
    agentKey.startsWith("karos-linkedin-company-")
  );
}

/**
 * Which identity a run belongs to. `company` is the page; anything else is a
 * `ClientSeat` id, and the seat is verified against the client before it is
 * used — the value arrives from the browser's run dialog.
 */
export type LiRunIdentity = { kind: "company" } | { kind: "seat"; seatId: string };

export const LI_COMPANY_IDENTITY: LiRunIdentity = { kind: "company" };

/** The brief-field key the run dialog carries the identity in. */
export const LI_IDENTITY_FIELD_KEY = "li_identity";

/**
 * Resolve a browser-supplied identity token against this client's own seats.
 *
 * Unknown tokens, seats belonging to another client and absent values all fall
 * back to the company page rather than erroring: the identity picks which of the
 * client's OWN records a run reads, so the failure mode of a bad token has to be
 * "drafted for the page" and never "drafted for someone else's person".
 */
export async function resolveLiRunIdentity(
  clientId: string,
  raw: string | undefined | null,
): Promise<LiRunIdentity> {
  const token = raw?.trim();
  if (!token || token === "company") return LI_COMPANY_IDENTITY;
  const seatId = token.startsWith("seat:") ? token.slice("seat:".length) : token;
  const seats = await listClientSeats(clientId);
  return seats.some((s) => s.id === seatId) ? { kind: "seat", seatId } : LI_COMPANY_IDENTITY;
}

/** The identity's stable slug in the lab's file names ("company" or the seat slug). */
function identitySlug(identity: LiRunIdentity, seats: ClientSeat[]): string {
  if (identity.kind === "company") return "company";
  return seats.find((s) => s.id === identity.seatId)?.slug ?? "company";
}

/** The `LiDraftFeedback.account` / `LiDirectionRequest.account` key for an identity. */
function identityAccount(identity: LiRunIdentity): string {
  return identity.kind === "company" ? "company" : identity.seatId;
}

/* ─────────────────────────────── the run gate ───────────────────────────── */

/**
 * Whether the client's LinkedIn intake is set up enough to run `agentKey`.
 *
 * All three v2 skills gate on the COMPANY form being saved, including setup
 * itself. That is deliberate and it is the flow, not an obstacle: the run dialog
 * renders the form inline while the intake is unset, so pressing Run the first
 * time IS the form. Saving it with empty answers satisfies the gate — the lab's
 * setup derives everything from the onboarding documents and could run on
 * nothing, so this is the portal's own policy that the client sees their data
 * page once before an agent writes in their name.
 *
 * The e10 keys keep their existing behaviour exactly: company-page instances on
 * the company form, the Path-B master on ANY LinkedIn intake (it has no company
 * form of its own, and collapsing the two locks it out of a workspace that is
 * fully set up on the seat side).
 *
 * A bare shared `ClientSeat` never satisfies any of these. One person has one
 * seat across every agent, so a seat created for the X agent says nothing about
 * LinkedIn — gating on it would silently skip the form the gate exists to raise.
 */
export async function hasLinkedInAgentIntake(clientId: string, agentKey?: string): Promise<boolean> {
  if (agentKey === "karos-linkedin-agent") {
    return (await listAgentIntake(clientId, "linkedin")).length > 0;
  }
  return (await getAgentIntake(clientId, "linkedin", null)) !== null;
}

/**
 * Whether this client has been through v2 setup — i.e. whether the writer has
 * anything to write from.
 *
 * Asked of the FOUNDATION row, because that is the one file setup's own join
 * check (S11) treats as this client's LinkedIn source of truth, and the one the
 * writer reads at step 02 and the manager at step 03. A client with intake but
 * no foundation has filled in a form and never been stood up.
 */
export async function hasLinkedInV2Setup(clientId: string): Promise<boolean> {
  const state = await listLiAgentState(clientId);
  return state.some((row) => row.kind === "foundation" && row.content.trim().length > 0);
}

/**
 * Whether a SEAT is ready to be drafted for: it has a voice card. The lab is
 * explicit that a seat run without one is `blocked_intake` rather than a draft
 * in a borrowed voice — "the run says so honestly instead of drafting in someone
 * else's voice on a personal profile" — so the portal asks the same question
 * before offering the seat as a runnable identity.
 */
export async function listLinkedInReadySeatIds(clientId: string): Promise<string[]> {
  const profiles = await listSeatVoiceProfiles(clientId, "linkedin");
  return profiles.filter((p) => p.content.trim().length > 0).map((p) => p.seatId);
}

/* ──────────────────────────── the combined file ─────────────────────────── */

/** Most recent feedback rows serialized per identity (the learning-log source). */
const FEEDBACK_ROWS_PER_ACCOUNT = 30;

function companySection(intake: AgentIntake | null): string {
  if (!intake) return "## Company page\n- No company intake stored yet.";
  const lines: string[] = ["## Company page"];
  lines.push(
    `- Page URL: ${intake.handle ?? "none yet (drafts only — nothing can be posted until the page exists)"}`,
  );
  if (intake.comeAcross) lines.push(`- How the company wants to come across on LinkedIn: ${intake.comeAcross}`);
  lines.push(`- Never post (off-limits): ${intake.offLimits || "(none given — house rules still apply)"}`);
  return lines.join("\n");
}

/** The lowercased extension of the seat's CV file name ("" when absent). */
function cvExt(cvName: string | undefined): string {
  return cvName?.includes(".") ? `.${cvName.split(".").pop()!.toLowerCase()}` : "";
}

function seatSection(
  seat: ClientSeat,
  intake: AgentIntake | null,
  voiceCard: SeatVoiceProfile | null,
): string {
  const lines: string[] = [
    `## Seat — ${seat.name}`,
    `- Person: ${seat.name} (identity slug: ${seat.slug})`,
  ];
  if (!intake) {
    lines.push("- No LinkedIn intake stored yet for this seat (it may belong to another agent).");
  } else {
    lines.push(
      `- Profile URL: ${intake.handle ?? "PENDING (seat drafts only — cannot post; no posts to read for voice)"}`,
    );
    if (intake.role) lines.push(`- Company role (their words): ${intake.role}`);
    if (intake.focus) lines.push(`- Profile focus (topics to be known for): ${intake.focus}`);
    lines.push(`- Never post (off-limits): ${intake.offLimits || "(none given — house rules still apply)"}`);
    lines.push(
      intake.cvName
        ? `- CV: "${intake.cvName}" — attached to this run as cv--${seat.slug}${cvExt(intake.cvName)} (substance, not voice).`
        : "- CV: none uploaded yet. Substance must come from real posts or the voice sample; never invent experience.",
    );
    if (intake.fallbackKind && intake.fallbackText) {
      lines.push(
        intake.fallbackKind === "writing"
          ? "- Voice sample (their own genuine writing — voice-shaping allowed):"
          : "- Voice sample (who-they-are notes / spoken transcript — the strongest voice source):",
      );
      lines.push("", "```", intake.fallbackText, "```");
    }
  }
  // The seat's voice card, inline. This section IS
  // linkedin-voice-card-<slug>.json for this run — see the header.
  if (voiceCard?.content.trim()) {
    lines.push(
      "",
      `### Voice card — ${seat.name} (built ${new Date(voiceCard.builtAt).toISOString().slice(0, 10)}, version ${voiceCard.version})`,
      "",
      "THIS IS THIS SEAT'S VOICE CARD for this run. Treat it as",
      `linkedin-voice-card-${seat.slug}.json: it is the identity's binding voice`,
      "rules, and it satisfies the writer's step-02 read for this identity.",
      "",
      voiceCard.content.trim(),
    );
  } else {
    lines.push(
      "",
      `### Voice card — ${seat.name}: NOT BUILT YET`,
      "",
      "This seat has no voice card. A run for THIS identity is `blocked_intake`,",
      "naming this seat — never draft on a person's profile in a borrowed voice.",
      "Seat setup is what builds it. A run for the company page or for a seat that",
      "does have a card is unaffected.",
    );
  }
  return lines.join("\n");
}

function feedbackSection(account: string, label: string, rows: LiDraftFeedback[]): string {
  const scoped = rows.filter((r) => r.account === account).slice(0, FEEDBACK_ROWS_PER_ACCOUNT);
  if (scoped.length === 0) return `### ${label}\n- No feedback yet.`;
  const lines = scoped.map((r) => {
    const when = new Date(r.createdAt).toISOString().slice(0, 10);
    const ref = r.draftRef ? ` on "${r.draftRef}"` : "";
    if (r.action === "posted") return `- ${when}: posted as drafted${ref}.`;
    if (r.action === "posted_with_edits")
      return `- ${when}: posted with edits${ref}. Final text used: ${r.finalText ?? "(not captured)"}`;
    if (r.action === "note") return `- ${when}: client note${ref}: ${r.reason ?? "(empty)"}`;
    if (r.action === "edit_request")
      return `- ${when}: change requested${ref}: ${r.reason ?? "(empty)"} — apply it when this subject or style comes up again.`;
    return `- ${when}: not posted${ref}. Reason: ${r.reason ?? "(not given)"}`;
  });
  return `### ${label}\n${lines.join("\n")}`;
}

/**
 * The ONE file carrying the company and every seat: their intake answers, their
 * voice cards and their learning logs, plus which identity this run is for.
 *
 * The header is doing real work, not decoration. It tells the run that these
 * sections stand in for the per-identity paths the skill would otherwise look
 * for, and it names the identity so a seat run reads its own section — the two
 * facts that let a single file satisfy a contract written for several.
 */
function combinedIntakeMd(args: {
  identity: LiRunIdentity;
  identityLabel: string;
  company: AgentIntake | null;
  companyVoiceCard: LiAgentState | null;
  seats: ClientSeat[];
  intakeBySeat: Map<string, AgentIntake>;
  voiceCardBySeat: Map<string, SeatVoiceProfile>;
  feedback: LiDraftFeedback[];
}): string {
  const {
    identity,
    identityLabel,
    company,
    companyVoiceCard,
    seats,
    intakeBySeat,
    voiceCardBySeat,
    feedback,
  } = args;

  const seatBlocks = seats.map((seat) =>
    [
      seatSection(seat, intakeBySeat.get(seat.id) ?? null, voiceCardBySeat.get(seat.id) ?? null),
      "",
      feedbackSection(seat.id, `Learning log — ${seat.name}`, feedback),
    ].join("\n"),
  );

  const companyCard = companyVoiceCard?.content.trim()
    ? [
        `### Voice card — the company page (built ${companyVoiceCard.contentDate}, version ${companyVoiceCard.version})`,
        "",
        "THIS IS THE COMPANY IDENTITY'S VOICE CARD for this run. Treat it as",
        "linkedin-voice-card-company.json — it satisfies the writer's step-02 read.",
        "",
        companyVoiceCard.content.trim(),
      ].join("\n")
    : [
        "### Voice card — the company page: NOT BUILT YET",
        "",
        "Setup has not produced one. The permitted fallback for the COMPANY identity",
        "only: read the brand voice document directly and record that in",
        "02-inputs.json. The run works, it just costs more. (A seat has no such",
        "fallback.)",
      ].join("\n");

  return [
    "# LinkedIn agent — the portal's client data (all identities, one file)",
    "",
    "SOURCE OF TRUTH. This is the portal's live LinkedIn data for this client and it",
    "OVERRIDES every older copy in the baked repo (clients/<slug>/internal/",
    "linkedin-agent/, clients/<slug>/skills/_shared/) on any disagreement.",
    "",
    "READ THIS PART CAREFULLY — the file layout is deliberately not the lab's:",
    "",
    "The lab contract pins one file per identity (linkedin-voice-card-<id>.json,",
    "linkedin-learning-log-<id>.md). THIS PORTAL DELIBERATELY SHIPS ONE FILE for the",
    "company and every seat, because a seat belongs to the company and needs the",
    "company's context to write in. The sections below ARE those per-identity files:",
    "",
    "  - a `### Voice card — <identity>` section IS that identity's voice card",
    "  - a `### Learning log — <identity>` section IS that identity's learning log",
    "  - the `## Company page` / `## Seat — <name>` sections are the intake answers",
    "",
    "Do NOT go looking for the per-identity paths and do NOT report blocked_intake",
    "because a per-identity file is absent from disk. Absent HERE is the only",
    "absence that counts, and a missing voice card says so in its own section.",
    "",
    `THIS RUN'S IDENTITY: **${identityLabel}**. Read the shared company context PLUS`,
    "this identity's own sections. Every output belongs to this identity alone, and",
    "the other identities' sections are here for two reasons only: a seat needs the",
    "company's master context, and the ledger's sibling flag needs to know who else",
    "posts for this client. Never mix identities in one run's output.",
    "",
    "Voice, pillars, cadence, language and launch-vs-ongoing are BUILT by the agent",
    "from the onboarding profile, the person's real posts and the edit loop. They are",
    "never collected from the client and must never be asked of them.",
    "",
    "---",
    "",
    companySection(company),
    "",
    companyCard,
    "",
    feedbackSection("company", "Learning log — the company page", feedback),
    "",
    ...(seatBlocks.length > 0
      ? seatBlocks
      : ["## Seats\n- None. This client runs the company page only."]),
    "",
    "---",
    "",
    feedbackSection("program", "Program feedback (applies to EVERY identity)", feedback),
    "",
    ...(identity.kind === "seat"
      ? [
          "## A note on this seat run",
          "",
          "This is a personal profile, not the page. A personal post is natively text and",
          "the text is the whole deliverable. Never carry a company-page visual",
          "requirement onto a person's profile.",
        ]
      : []),
  ].join("\n");
}

/* ────────────────── the live section: direction requests + drops ────────── */

/** Markdown-table cell sanitizer — a stray pipe or newline shifts every later column. */
function cell(value: string): string {
  return value.replace(/\|/g, "/").replace(/\n/g, " ");
}

/** One shared-news row as a company-updates.md Section A table row. */
function newsTableRow(n: XNewsUpdate): string {
  const what = n.detail ? `${n.title} — ${n.detail}` : n.title;
  const hasNumber = /\d/.test(`${n.title} ${n.detail ?? ""}`);
  const cells = [
    n.date,
    what,
    n.type ?? "",
    n.url ?? "",
    hasNumber ? (n.sourceUrl ?? "MISSING — do not post the number without a source") : (n.sourceUrl ?? ""),
    n.consent ?? "",
    "",
    "",
    "new",
  ];
  return `| ${cells.map(cell).join(" | ")} |`;
}

/** One direction request as a Section A0 row, labelled with the identity it steers. */
function directionTableRow(r: LiDirectionRequest, label: string): string {
  return `| ${[r.date, cell(r.request), cell(label), r.status].join(" | ")} |`;
}

/**
 * The client's live section in the engine's `company-updates.md` shape, with
 * Section A0 — the v2 addition the lab calls "the steering wheel" and the writer
 * treats as the brief for its batch.
 *
 * One file for every identity, for the same reason the intake file is one file:
 * a seat needs the company's context. Each A0 row names which identity it
 * steers, and the header tells the run which rows are its brief.
 */
function liveSectionMd(args: {
  identityLabel: string;
  identityAccount: string;
  requests: LiDirectionRequest[];
  labelForAccount: (account: string) => string;
  news: XNewsUpdate[];
}): string {
  const { identityLabel, identityAccount, requests, labelForAccount, news } = args;
  const open = requests.filter((r) => r.status === "open");
  const mine = open.filter((r) => r.account === identityAccount);
  const others = open.filter((r) => r.account !== identityAccount);
  const covered = requests.filter((r) => r.status === "covered").slice(0, 20);

  const newsRows = [...news].sort((a, b) => (a.date < b.date ? 1 : -1)).map(newsTableRow);

  return [
    "# Company updates — the portal's live copy",
    "",
    "SOURCE OF TRUTH for this client's live section. If the baked repo carries an",
    "older copy at clients/<slug>/internal/linkedin-agent/company-updates.md, or a",
    "per-seat live/<id>.md, the rows below WIN on any disagreement. This one file",
    "serves every identity; Section B stays agent-maintained.",
    "",
    `THIS RUN'S IDENTITY: **${identityLabel}**.`,
    "",
    "## Section A0 · Direction requests (the steering wheel)",
    "",
    "An OPEN row addressed to this run's identity is **the brief for this batch** —",
    "fill slots with what was asked for first, then round out with the usual",
    "variety. The precedence is: the run note typed at the Run moment (freshest of",
    "all) → these direction requests → the drops in Section A → the topic catalog.",
    "",
    "Report every request you covered in 12-commit.json under the key",
    "`direction_requests_covered`, as the exact request text. The portal flips those",
    "rows to covered; do not expect a row you covered to be gone next run unless it",
    "was reported.",
    "",
    "### Open — addressed to THIS identity (the brief)",
    "",
    "| Date added | What they want covered | For | Status |",
    "|---|---|---|---|",
    ...(mine.length > 0
      ? mine.map((r) => directionTableRow(r, labelForAccount(r.account)))
      : ["| | (nothing open for this identity — the catalog and the drops carry this run) | | |"]),
    "",
    "### Open — addressed to OTHER identities (context, NOT this run's brief)",
    "",
    "| Date added | What they want covered | For | Status |",
    "|---|---|---|---|",
    ...(others.length > 0
      ? others.map((r) => directionTableRow(r, labelForAccount(r.account)))
      : ["| | (none) | | |"]),
    "",
    ...(covered.length > 0
      ? [
          "### Already covered (do not treat as a brief; useful as history)",
          "",
          "| Date added | What they wanted covered | For | Status |",
          "|---|---|---|---|",
          ...covered.map((r) => directionTableRow(r, labelForAccount(r.account))),
          "",
        ]
      : []),
    "## Section A · Your updates (the drop box)",
    "",
    "One input per client, shared with the X agent (the client types it once). A row",
    "with a number and no source URL cannot have the number posted.",
    "",
    "| Date added | What happened (one line) | Type | Link or asset | Source URL (only if it has a number) | People + consent (spotlights/quotes) | Who will amplify | Preferred date | Status |",
    "|---|---|---|---|---|---|---|---|---|",
    ...(newsRows.length > 0
      ? newsRows
      : ["| | (no client drops yet — the catalog and the pull carry the page) | | | | | | | |"]),
    "",
    "### Optional: a standing point of view",
    "",
    "| Date added | Rough take / opinion (a sentence is fine) | On what topic | Status |",
    "|---|---|---|---|",
    "",
    "(no portal input for this yet — the empty table keeps the engine contract)",
    "",
    "## Section B · Auto-detected news (the agent fills this, not you)",
    "",
    "| Date | Item | Source (url / channel) | Type | Permission needed? | Posted? |",
    "|---|---|---|---|---|---|",
    "",
  ].join("\n");
}

/* ─────────────────────── the durable state the runner loses ─────────────── */

/** How each `liAgentState` kind is re-attached: file name, type, and what it is. */
const STATE_FILES: Record<
  LiAgentState["kind"],
  { name: string; contentType: string; description: string } | null
> = {
  ledger: {
    name: "linkedin-ledger.json",
    contentType: "application/json",
    description:
      "The continuity spine: one row per delivered post, each owned by one identity. THIS IS THE LIVE LEDGER for this client — the baked repo's copy is stale. Read it for the 60-day hard block on this identity's own subjects and for the sibling flag on other identities' subjects. Append your new rows to THIS content and deliver the whole updated file back as linkedin-ledger.json.",
  },
  "topic-catalog": {
    name: "topic-catalog.yaml",
    contentType: "text/yaml",
    description:
      "The shared forward pipeline with its used_by lists. THIS IS THE LIVE CATALOG — the baked topic-catalog.yaml is stale; a row this file marks used by an identity is used, whatever the repo says. Deliver the whole updated file back as topic-catalog.yaml.",
  },
  "agent-memory": {
    name: "AGENT-MEMORY.md",
    contentType: "text/markdown",
    description:
      "The manager's own memory — its standing decisions with their dates and reasons. Append-only: a reversal is a new dated entry naming what it reverses. A decision here is NOT re-litigated without new evidence. Only the manager writes this; deliver the whole updated file back as AGENT-MEMORY.md.",
  },
  "manager-plan": {
    name: "manager-plan.json",
    contentType: "application/json",
    description:
      "The most recent manager plan (the manager's 05-plan.json): the standing lane mix per identity, which subjects are retired, and the reason per change. THIS IS THE PLAN IN FORCE for this run. Record which plan you ran on in 01-run.json.",
  },
  "research-cache": {
    name: "research-cache.json",
    contentType: "application/json",
    description:
      "The manager's cached research pull. Its date is in the payload and in this file's name convention: a SAME-DAY pull is reused and never re-bought. Only pull fresh if this cache is not from today, and if you do, deliver the raw payload back as research-cache.json before anything parses it.",
  },
  foundation: {
    name: "LINKEDIN-FOUNDATION.md",
    contentType: "text/markdown",
    description:
      "This client's LinkedIn source of truth from setup: the active lanes and their shares, the cadence, the signature series, the compliance block and the house rules. Authoritative for this client. THIS IS THE LIVE COPY.",
  },
  // Rendered inside the combined intake file instead of as its own attachment,
  // so the company's voice card sits beside the company's other answers exactly
  // as a seat's does.
  "voice-card-company": null,
};

/* ─────────────────────────── prior delivered batches ───────────────────── */

/** How many prior draft batches each run receives for anti-duplication. */
const PRIOR_BATCHES = 3;
const PRIOR_BATCH_MAX_CHARS = 20_000;

async function upload(clientId: string, runKey: string, name: string, body: string, contentType: string) {
  const { url } = await uploadBytes({
    bytes: Buffer.from(body, "utf8"),
    path: `clients/${clientId}/linkedin-agent/portal-context/${runKey}/${name}`,
    contentType,
  });
  return url;
}

/**
 * Prior portal-run batches, newest first.
 *
 * Still injected even though the ledger is now durable, because the two answer
 * different questions: the ledger carries FINGERPRINTS (subject key, proper
 * nouns, numbers, angle, hook) while these carry the actual delivered prose,
 * which is what a run needs to avoid echoing its own phrasing — the failure the
 * lab names as "near-identical wording across accounts".
 *
 * Scoped to every LinkedIn agent of this client, not just the launching one: the
 * ledger is shared across identities by contract, so a seat run must see the
 * page's batches and vice versa.
 */
async function priorBatchFiles(
  clientId: string,
  agentName: string,
  runKey: string,
): Promise<AgentServiceContextFile[]> {
  const linkedInAgentNames = new Set(
    (await listCustomAgents()).filter((a) => isLinkedInAgent(a.key)).map((a) => a.name),
  );
  linkedInAgentNames.add(agentName);
  const jobs = (await listJobs({ clientId }))
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        linkedInAgentNames.has(j.agentName) &&
        ["review", "approved", "delivered"].includes(j.status) &&
        j.assetIds.length > 0,
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, PRIOR_BATCHES);

  // Read and upload the prior batches in PARALLEL rather than one at a time
  // (review, 2026-09): this runs inside the submit action, so every sequential
  // asset read plus GCS upload was wall-clock the person launching the run sat
  // through. Mapping preserves order, so the files still arrive newest first.
  const files = await Promise.all(
    jobs.map(async (job): Promise<AgentServiceContextFile | null> => {
      const asset = await getAsset(job.assetIds[0]);
      if (!asset?.content?.trim()) return null;
      const when = new Date(job.createdAt).toISOString().slice(0, 10);
      const name = `prior-batch-${when}-${job.id.slice(0, 6)}.md`;
      return {
        name,
        url: await upload(clientId, runKey, name, asset.content.slice(0, PRIOR_BATCH_MAX_CHARS), "text/markdown"),
        content_type: "text/markdown",
        description: `A previous portal delivery for this client (${when}). Every subject, angle, hook and phrasing in it is ALREADY POSTED — never reuse one, and never echo its wording even on a subject that is legitimately open again.`,
      };
    }),
  );
  return files.filter((f): f is AgentServiceContextFile => f !== null);
}

/* ────────────────────────────── the entry point ─────────────────────────── */

export interface LinkedInContextArgs {
  clientId: string;
  /** The customAgents doc's key — decides which files this run needs. */
  agentKey: string;
  /** The customAgents doc's name; scopes the prior-batch lookup. */
  agentName?: string;
  /** Which identity this run is for. Defaults to the company page. */
  identity?: LiRunIdentity;
}

/**
 * Builds the LinkedIn agent's portal-data context files for one run. Returns []
 * when there is nothing at all to say, so callers can append unconditionally.
 *
 * The file set is per skill, because attaching a file a skill has no step for is
 * not free — it is context the run pays for and may act on:
 *
 *  - SETUP reads the client's answers and writes the starting kit. It gets the
 *    combined intake file and the live section. No ledger, no prior batches:
 *    there is nothing to not-repeat yet, and S8 must see an absent file as
 *    absent so it creates it rather than recording it as already present.
 *  - The WRITER gets everything: the combined file, the live section, the
 *    durable state, the prior batches, the CVs. This also covers the manager
 *    SKILL's automatic pass that runs inside every writer press — it is not a
 *    separate `agentKey` and was never branched on here.
 *
 * The standalone manager card (`karos-linkedin-manager-v2`) used to be a third
 * branch — its own `agentKey`, fed the state it audits and steers from
 * (ledger, catalog, memory, its own last plan, the research cache) but no CVs
 * and no voice cards it had no authority to change. Retired 2026-08-29
 * (SCRUM-377/T-B25a): no engine equivalent was ever planned, and no job can
 * carry that key any more, so the branch is gone rather than left dead.
 */
export async function buildLinkedInAgentContextFiles(
  args: LinkedInContextArgs,
): Promise<AgentServiceContextFile[]> {
  const { clientId, agentKey, agentName } = args;
  const identity = args.identity ?? LI_COMPANY_IDENTITY;
  const isSetup = isLinkedInSetupV2(agentKey);
  // Every e10 key and the v2 writer take the full drafting set.
  const isWriter = !isSetup;

  const [seats, intakes, news, feedback, requests, state, voiceCards] = await Promise.all([
    listClientSeats(clientId),
    listAgentIntake(clientId, "linkedin"),
    listXNewsUpdates(clientId),
    listLiDraftFeedback(clientId),
    listLiDirectionRequests(clientId),
    listLiAgentState(clientId),
    listSeatVoiceProfiles(clientId, "linkedin"),
  ]);

  const company = intakes.find((i) => i.seatId === null) ?? null;
  const hasAnything =
    company !== null ||
    intakes.length > 0 ||
    news.length > 0 ||
    requests.length > 0 ||
    state.length > 0;
  if (!hasAnything) return [];

  const files: AgentServiceContextFile[] = [];
  const runKey = randomUUID();

  const intakeBySeat = new Map(intakes.filter((i) => i.seatId).map((i) => [i.seatId as string, i]));
  const voiceCardBySeat = new Map(voiceCards.map((v) => [v.seatId, v]));
  const seatById = new Map(seats.map((s) => [s.id, s]));
  const slug = identitySlug(identity, seats);
  const identityLabel =
    identity.kind === "company"
      ? "the company page (identity slug: company)"
      : `${seatById.get(identity.seatId)?.name ?? "a seat"} — a personal profile (identity slug: ${slug})`;
  const labelForAccount = (account: string) =>
    account === "company"
      ? "the company page"
      : account === "program"
        ? "every identity"
        : (seatById.get(account)?.name ?? "an identity that no longer has a seat");

  // 1. Prior batches first — the anti-duplication ground truth for this run.
  if (agentName && !isSetup) {
    files.push(...(await priorBatchFiles(clientId, agentName, runKey)));
  }

  // 2. The one combined identity file. The manager audits per identity and reads
  //    the outcomes, so it needs this too — it simply may not change a voice.
  const intakeMd = combinedIntakeMd({
    identity,
    identityLabel,
    company,
    companyVoiceCard: state.find((s) => s.kind === "voice-card-company") ?? null,
    seats,
    intakeBySeat,
    voiceCardBySeat,
    feedback,
  });
  files.push({
    name: "linkedin-portal-intake.md",
    url: await upload(clientId, runKey, "linkedin-portal-intake.md", intakeMd, "text/markdown"),
    content_type: "text/markdown",
    description:
      "The portal's live LinkedIn data for this client, ALL identities in ONE file: the company page and every seat, each with its voice card and its learning log, plus which identity this run is for. Its sections stand in for the lab's per-identity files — read the header before looking for a per-identity path.",
  });

  // 3. The live section: direction requests (the brief) + the shared drop box.
  const updatesMd = liveSectionMd({
    identityLabel,
    identityAccount: identityAccount(identity),
    requests,
    labelForAccount,
    news,
  });
  files.push({
    name: "company-updates.md",
    url: await upload(clientId, runKey, "company-updates.md", updatesMd, "text/markdown"),
    content_type: "text/markdown",
    description:
      "The client's live section: Section A0 direction requests (an open row for this run's identity IS the brief for this batch) and Section A drops. Overrides the repo copy and any per-seat live section.",
  });

  // 4. The durable state the ephemeral workspace would otherwise lose.
  const stateKinds: LiAgentState["kind"][] = isSetup
    ? // Setup stands these up; handing it the current copies would make S8
      // record "already present" for files this client may genuinely not have,
      // and re-running setup is a supported operation. The foundation is the
      // exception: a re-run must see it so it does not rewrite a live one.
      ["foundation"]
    : ["foundation", "ledger", "topic-catalog", "manager-plan"];
  for (const kind of stateKinds) {
    const row = state.find((s) => s.kind === kind);
    const spec = STATE_FILES[kind];
    if (!row || !spec || !row.content.trim()) continue;
    files.push({
      name: spec.name,
      url: await upload(clientId, runKey, spec.name, row.content, spec.contentType),
      content_type: spec.contentType,
      description: `${spec.description} (portal copy, captured ${row.contentDate} from run ${row.capturedFromJobId}, version ${row.version}.)`,
    });
  }

  // 5. Each seat's uploaded CV — substance for the persona, never voice. Only a
  //    drafting run needs them; the manager has no drafting step.
  if (isWriter || isSetup) {
    for (const seat of seats) {
      const intake = intakeBySeat.get(seat.id);
      if (!intake?.cvUrl || !intake.cvName) continue;
      const ext = cvExt(intake.cvName);
      files.push({
        name: `cv--${seat.slug}${ext}`,
        url: intake.cvUrl,
        content_type:
          ext === ".pdf"
            ? "application/pdf"
            : ext === ".docx"
              ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              : "text/plain",
        description: `${seat.name}'s private CV upload (original filename: ${intake.cvName}). Substance only — real experience for the persona; never a voice source, never client-visible, never posted.`,
      });
    }
  }

  return files;
}
