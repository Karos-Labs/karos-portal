import "server-only";

/**
 * LinkedIn agent (e10) run-time context: serializes the portal-collected
 * LinkedIn intake (company form, seats incl. CVs and voice fallbacks, the
 * shared company news drop, per-account draft feedback) into files uploaded
 * to storage and attached to the run as context_files — the same injection
 * path the X agent (e13) uses. Purely additive: agents other than the e10
 * LinkedIn agents never hit this module.
 *
 * The news drop is the SHARED "what happened this week" box (SCRUM-51): the
 * client types an update once; the X build serializes it as whats-new.json
 * and this build serializes the SAME rows as company-updates.md Section A —
 * the exact file shape the e10 company-page skill reads.
 */

import { randomUUID } from "crypto";
import {
  getAgentIntake,
  getAsset,
  listAgentIntake,
  listClientSeats,
  listCustomAgents,
  listJobs,
  listLiDraftFeedback,
  listXNewsUpdates,
} from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { AgentIntake, ClientSeat, LiDraftFeedback, XNewsUpdate } from "@/lib/types";

/**
 * The e10 LinkedIn agents in customAgents: the per-client company-page
 * instances (karos-linkedin-company-<slug>) and the lab master. Client-safe
 * twin: isLinkedInAgentIdentity in custom-agent-launch.ts.
 */
export function isLinkedInAgent(agentKey: string): boolean {
  return agentKey === "karos-linkedin-agent" || agentKey.startsWith("karos-linkedin-company-");
}

/**
 * Whether the client's LinkedIn intake is set up enough to run a LinkedIn
 * agent: the company form must be SAVED. The company page is the floor for
 * every intake-driven agent and seats are additive — a seat is shared across
 * agents (one person, one seat), so a bare seat says nothing about LinkedIn and
 * never satisfies the gate on its own. Saving the form with empty answers does,
 * which is the deliberate portal policy: the lab contract would allow a
 * zero-input Path A run, but this portal wants the data seen first.
 *
 * Uniform across the e10 keys — the Path B master gates identically, which is
 * why it takes no agent key: there is no answer a key could change. The `ready`
 * flag on the agents page is derived from the same intake doc; a drift un-gates
 * a run.
 */
export async function hasLinkedInAgentIntake(clientId: string): Promise<boolean> {
  return (await getAgentIntake(clientId, "linkedin", null)) !== null;
}

/** Most recent feedback rows serialized per account (the Learning Log source). */
const FEEDBACK_ROWS_PER_ACCOUNT = 30;

function companySection(intake: AgentIntake): string {
  const lines: string[] = ["## Company page"];
  lines.push(`- Page URL: ${intake.handle ?? "none yet (drafts only — nothing can be posted until the page exists)"}`);
  if (intake.comeAcross) lines.push(`- How the company wants to come across on LinkedIn: ${intake.comeAcross}`);
  lines.push(`- Never post (off-limits): ${intake.offLimits || "(none given — house rules still apply)"}`);
  return lines.join("\n");
}

/** The lowercased extension of the seat's CV file name ("" when absent). */
function cvExt(cvName: string | undefined): string {
  return cvName?.includes(".") ? `.${cvName.split(".").pop()!.toLowerCase()}` : "";
}

function seatSection(seat: ClientSeat, intake: AgentIntake | null): string {
  const lines: string[] = [`## Seat — ${seat.name}`, `- Person: ${seat.name} (slug: ${seat.slug})`];
  if (!intake) {
    lines.push("- No LinkedIn intake stored yet for this seat (it may belong to another agent).");
    return lines.join("\n");
  }
  lines.push(`- Profile URL: ${intake.handle ?? "PENDING (seat drafts only — cannot post; no posts to read for voice)"}`);
  if (intake.role) lines.push(`- Company role (their words): ${intake.role}`);
  if (intake.focus) lines.push(`- Profile focus (topics to be known for): ${intake.focus}`);
  lines.push(`- Never post (off-limits): ${intake.offLimits || "(none given — house rules still apply)"}`);
  lines.push(
    intake.cvName
      ? `- CV: "${intake.cvName}" — attached to this run as cv--${seat.slug}${cvExt(intake.cvName)} (substance, not voice).`
      : "- CV: none uploaded yet. Substance must come from real posts or the voice sample; never invent experience.",
  );
  if (!intake.handle && !intake.cvName && !intake.fallbackKind) {
    lines.push(
      "- BELOW INPUT MINIMUM: no profile, no CV, no voice sample. Draft only what the role and company profile genuinely support; keep the voice provisional and flag it in the draft's notes.",
    );
  }
  if (intake.fallbackKind && intake.fallbackText) {
    lines.push(
      intake.fallbackKind === "writing"
        ? "- Voice sample (their own genuine writing — voice-shaping allowed):"
        : "- Voice sample (who-they-are notes / spoken transcript — the strongest voice source):",
    );
    lines.push("");
    lines.push("```");
    lines.push(intake.fallbackText);
    lines.push("```");
  }
  return lines.join("\n");
}

function feedbackSection(account: string, label: string, rows: LiDraftFeedback[]): string {
  const scoped = rows.filter((r) => r.account === account).slice(0, FEEDBACK_ROWS_PER_ACCOUNT);
  if (scoped.length === 0) return `## ${label}\n- No feedback yet.`;
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
  return `## ${label}\n${lines.join("\n")}`;
}

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

/** The client's live news rows in the engine's company-updates.md Section A shape. */
function companyUpdatesMd(news: XNewsUpdate[]): string {
  const rows = [...news].sort((a, b) => (a.date < b.date ? 1 : -1)).map(newsTableRow);
  return [
    "# Company updates — portal live copy",
    "",
    "SOURCE OF TRUTH: this file is the portal's live company-updates drop for this",
    "client (the shared 'what happened this week' box — one input, consumed by both",
    "the X and LinkedIn agents). If the baked repo contains an older copy at",
    "clients/<slug>/internal/linkedin-agent/company-updates.md, the Section A rows",
    "below WIN on any disagreement. Section B stays agent-maintained.",
    "",
    "## Section A · Your updates (drop here, whenever you want)",
    "",
    "| Date added | What happened (one line) | Type | Link or asset | Source URL (only if it has a number) | People + consent (spotlights/quotes) | Who will amplify | Preferred date | Status |",
    "|---|---|---|---|---|---|---|---|---|",
    ...(rows.length > 0 ? rows : ["| | (no client drops yet — feeds 1 and 2 carry the page) | | | | | | | |"]),
    "",
    "### Optional: a standing point of view",
    "",
    "| Date added | Rough take / opinion (a sentence is fine) | On what topic | Status |",
    "|---|---|---|---|",
    "",
    "## Section B · Auto-detected news (the agent fills this, not you)",
    "",
    "(agent-maintained auto-pull cache — rebuild from first-party sources at run time;",
    "when a Section A row and an auto-pulled item describe the same event, the",
    "client's framing wins and the auto-pull enriches it)",
    "",
    "| Date | Item | Source (url / channel) | Type (company-page-spec §2) | Permission needed? | Posted? |",
    "|---|---|---|---|---|---|",
    "",
  ].join("\n");
}

async function upload(clientId: string, runKey: string, name: string, body: string, contentType: string) {
  const { url } = await uploadBytes({
    bytes: Buffer.from(body, "utf8"),
    path: `clients/${clientId}/linkedin-agent/portal-context/${runKey}/${name}`,
    contentType,
  });
  return url;
}

/** How many prior draft batches each run receives for anti-duplication. */
const PRIOR_BATCHES = 3;
const PRIOR_BATCH_MAX_CHARS = 20_000;

/**
 * Prior portal-run batches, newest first. The runner workspace is ephemeral —
 * the topic-catalog flips and ledger appends a run makes inside it are
 * DISCARDED with the workspace — so run-over-run anti-duplication only works
 * if each run RECEIVES the previous batches. The webhook stores each batch's
 * drafts markdown as the job asset's content; that is the durable copy we
 * re-inject.
 *
 * Scoped to ALL of the client's e10 agents, not just the launching one: the
 * lab contract shares ONE ledger across every LinkedIn generator, so a
 * master run must see the company instance's batches and vice versa.
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

  const files: AgentServiceContextFile[] = [];
  for (const job of jobs) {
    const asset = await getAsset(job.assetIds[0]);
    if (!asset?.content?.trim()) continue;
    const when = new Date(job.createdAt).toISOString().slice(0, 10);
    const name = `prior-batch-${when}-${job.id.slice(0, 6)}.md`;
    files.push({
      name,
      url: await upload(clientId, runKey, name, asset.content.slice(0, PRIOR_BATCH_MAX_CHARS), "text/markdown"),
      content_type: "text/markdown",
      description: `A previous portal draft for this client (${when}). NEVER reuse its subjects, angles, hooks, or phrasings — treat every entry as already posted, and treat its topic-catalog row as flipped to used even if the baked catalog still says unused.`,
    });
  }
  return files;
}

/**
 * Builds the LinkedIn agent's portal-data context files for one run. Returns
 * [] when nothing is stored, so callers can append unconditionally.
 * `agentName` (the customAgents doc name) scopes the prior-batch lookup.
 */
export async function buildLinkedInAgentContextFiles(
  clientId: string,
  agentName?: string,
): Promise<AgentServiceContextFile[]> {
  const [seats, intakes, news, feedback] = await Promise.all([
    listClientSeats(clientId),
    listAgentIntake(clientId, "linkedin"),
    listXNewsUpdates(clientId),
    listLiDraftFeedback(clientId),
  ]);
  const company = intakes.find((i) => i.seatId === null) ?? null;
  const hasAnything = company !== null || intakes.length > 0 || news.length > 0;
  if (!hasAnything) return [];

  const files: AgentServiceContextFile[] = [];
  const runKey = randomUUID();

  // 0. Prior batches first — the anti-duplication ground truth for this run.
  if (agentName) {
    files.push(...(await priorBatchFiles(clientId, agentName, runKey)));
  }

  // 1. The intake forms + learning logs, one markdown file.
  const intakeBySeat = new Map(intakes.filter((i) => i.seatId).map((i) => [i.seatId as string, i]));
  const seatSections = seats.map((seat) => {
    const intake = intakeBySeat.get(seat.id) ?? null;
    return [
      seatSection(seat, intake),
      feedbackSection(seat.id, `Learning log — ${seat.name}'s seat`, feedback),
    ].join("\n\n");
  });
  const intakeMd = [
    "# LinkedIn agent — portal-collected client data",
    "",
    "SOURCE OF TRUTH: this file is the portal's live LinkedIn intake for this client.",
    "If the baked repo contains older copies under",
    "clients/<slug>/internal/linkedin-agent/ (seat intakes, the company-updates drop),",
    "THIS FILE and the attached company-updates.md WIN on any disagreement.",
    "Voice, pillars, cadence, language and launch-vs-ongoing are BUILT by the agent",
    "(onboarding profile + the person's real posts + the edit loop) — they are not",
    "collected here and must never be asked of the client.",
    "",
    company ? companySection(company) : "## Company page\n- No company intake stored yet.",
    "",
    feedbackSection("company", "Learning log — company page", feedback),
    "",
    ...seatSections,
    "",
    feedbackSection("program", "Program feedback (applies to EVERY account)", feedback),
  ].join("\n");
  files.push({
    name: "linkedin-portal-intake.md",
    url: await upload(clientId, runKey, "linkedin-portal-intake.md", intakeMd, "text/markdown"),
    content_type: "text/markdown",
    description:
      "Portal-collected LinkedIn intake: company page + seats (profile URLs, roles, focus, off-limits, voice fallbacks) and per-account learning logs. Overrides any older linkedin-agent intake files in the repo.",
  });

  // 2. The shared company news drop, in the engine's company-updates.md Section A shape.
  const updatesMd = companyUpdatesMd(news);
  files.push({
    name: "company-updates.md",
    url: await upload(clientId, runKey, "company-updates.md", updatesMd, "text/markdown"),
    content_type: "text/markdown",
    description:
      "The client's live company-updates drop (the shared 'what happened this week' box) in the engine's company-updates.md Section A shape. Overrides the repo copy's Section A.",
  });

  // 3. Each seat's uploaded CV, attached directly (substance for the persona).
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

  return files;
}
