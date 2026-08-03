import "server-only";

/**
 * X agent (e13) run-time context: serializes the portal-collected X intake
 * (company form, seats, the two ongoing boxes, per-account draft feedback)
 * into files uploaded to storage and attached to the run as context_files —
 * the same injection path uploaded reference files already use. Purely
 * additive: agents other than the X agent never hit this module, and an X run
 * with no stored data attaches nothing.
 */

import { randomUUID } from "crypto";
import {
  getAgentIntake,
  getAgentProfileDocData,
  getAsset,
  listAgentIntake,
  listClientSeats,
  listJobs,
  listSeatVoiceProfiles,
  listXDraftFeedback,
  listXNewsUpdates,
  listXTakes,
} from "@/lib/data";
import type { AgentProfileScopeFields } from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { AgentIntake, ClientSeat, XDraftFeedback } from "@/lib/types";

/**
 * The imported lab-manifest key(s) of the X agent's customAgents docs. v2
 * (karos-x-agent-v2, products/building/x-agent-v2) is a separate agent from
 * v1 — both exist side by side so v2 can be reviewed against v1's reference
 * runs, per docs/one-pagers/x-agent-v2-FRAMEWORK.md. Everything gated or
 * injected here applies to either: same portal-collected intake, same
 * context-file contract.
 */
export function isXAgent(agentKey: string): boolean {
  return agentKey === "karos-x-agent" || agentKey === "karos-x-agent-v2";
}

/** Narrower than isXAgent — only true for the v2 rebuild, for callers that branch on it. */
export function isXAgentV2(agentKey: string): boolean {
  return agentKey === "karos-x-agent-v2";
}

/**
 * Whether the client's X intake is set up enough to run. Gates on the
 * company-page form being SAVED: we run X for a business, so the company page
 * is the floor and seats are additive on top of it. Bare shared seats never
 * satisfy the gate — one person keeps one seat across agents, so a seat may
 * have been created for LinkedIn and say nothing about X. Matches the
 * LinkedIn company-page policy in linkedin-agent-context.ts. Company identity
 * fields live in the profile doc now, but AgentIntake's company row is still
 * written alongside it on every save (roster/premium), so this stays a valid
 * existence check without a second read.
 */
export async function hasXAgentIntake(clientId: string): Promise<boolean> {
  return (await getAgentIntake(clientId, "x", null)) !== null;
}

/** Most recent feedback rows serialized per account (the Learning Log source). */
const FEEDBACK_ROWS_PER_ACCOUNT = 30;

/**
 * `intake` still carries roster/premium; `profile` carries handle/off-limits/
 * how-they-want-to-come-across, now stored in the agent's clientContextDocs
 * profile doc (see upsertAgentProfileScope) instead of AgentIntake.
 */
function intakeSection(
  label: string,
  intake: AgentIntake | null,
  profile: AgentProfileScopeFields | null,
  seat?: ClientSeat,
): string {
  const lines: string[] = [`## ${label}`];
  if (seat) lines.push(`- Person: ${seat.name} (slug: ${seat.slug})`);
  if (!intake && !profile) {
    lines.push("- No intake stored yet.");
    return lines.join("\n");
  }
  lines.push(
    `- Handle: ${profile?.handle ?? (seat ? "PENDING (seat drafts only — cannot post or self-sample)" : "none yet (launch mode)")}`,
  );
  if (profile?.comeAcross) lines.push(`- How they want to come across on X: ${profile.comeAcross}`);
  lines.push(`- Never post (off-limits): ${profile?.offLimits || "(none given — house rules still apply)"}`);
  const roster = intake?.roster ?? [];
  lines.push(
    roster.length > 0
      ? `- Engagement roster (activates the engagement lane): ${roster.join(", ")}`
      : "- Engagement roster: none given — engagement lane stays off.",
  );
  lines.push(
    intake?.premium === true
      ? "- X Premium: YES (client-confirmed) — long-form posts past 280 characters are allowed where the account's style supports them."
      : intake?.premium === false
        ? "- X Premium: NO (client-confirmed) — hard 280-character limit on every post."
        : "- X Premium: auto-detect — check the account's checkmark and its own posting style live before drafting anything past 280 characters.",
  );
  return lines.join("\n");
}

function feedbackSection(account: string, label: string, rows: XDraftFeedback[]): string {
  const scoped = rows.filter((r) => r.account === account).slice(0, FEEDBACK_ROWS_PER_ACCOUNT);
  if (scoped.length === 0) return `## ${label}\n- No feedback yet.`;
  const lines = scoped.map((r) => {
    const when = new Date(r.createdAt).toISOString().slice(0, 10);
    const ref = r.draftRef ? ` on "${r.draftRef}"` : "";
    if (r.action === "posted") return `- ${when}: posted as drafted${ref}.`;
    if (r.action === "posted_with_edits")
      return r.originalText
        ? `- ${when}: posted with edits${ref}. Original: ${r.originalText} → Final: ${r.finalText ?? "(not captured)"}`
        : `- ${when}: posted with edits${ref}. Final text used: ${r.finalText ?? "(not captured)"}`;
    if (r.action === "note") return `- ${when}: client note${ref}: ${r.reason ?? "(empty)"}`;
    return `- ${when}: not posted${ref}. Reason: ${r.reason ?? "(not given)"}`;
  });
  return `## ${label}\n${lines.join("\n")}`;
}

async function upload(clientId: string, runKey: string, name: string, body: string, contentType: string) {
  const { url } = await uploadBytes({
    bytes: Buffer.from(body, "utf8"),
    path: `clients/${clientId}/x-agent/portal-context/${runKey}/${name}`,
    contentType,
  });
  return url;
}

/** How many prior draft batches each run receives for anti-duplication. */
const PRIOR_BATCHES = 3;
const PRIOR_BATCH_MAX_CHARS = 20_000;

/**
 * Prior portal-run batches, newest first. The runner workspace is ephemeral —
 * ledger appends made inside a run are discarded with it — so run-over-run
 * anti-duplication only works if each run RECEIVES the previous batches. The
 * webhook stores each batch's DRAFTS markdown as the job asset's content;
 * that is the durable copy we re-inject.
 */
async function priorBatchFiles(
  clientId: string,
  agentName: string,
  runKey: string,
): Promise<AgentServiceContextFile[]> {
  const jobs = (await listJobs({ clientId }))
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        j.agentName === agentName &&
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
      description: `A previous portal draft batch for this client (${when}). NEVER reuse its subjects, sources, quoted posts, or phrasings — treat every entry as already used.`,
    });
  }
  return files;
}

/**
 * Builds the X agent's portal-data context files for one run. Returns [] when
 * nothing is stored, so callers can append unconditionally. `agentName` (the
 * customAgents doc name) scopes the prior-batch lookup.
 */
export async function buildXAgentContextFiles(
  clientId: string,
  agentName?: string,
): Promise<AgentServiceContextFile[]> {
  const [seats, intakes, news, takes, feedback, profileData, voiceProfiles] = await Promise.all([
    listClientSeats(clientId),
    listAgentIntake(clientId, "x"),
    listXNewsUpdates(clientId),
    listXTakes(clientId),
    listXDraftFeedback(clientId),
    getAgentProfileDocData(clientId, "x"),
    listSeatVoiceProfiles(clientId, "x"),
  ]);
  const company = intakes.find((i) => i.seatId === null) ?? null;
  // Whole-file-set gate: a client with genuinely nothing configured yet (never
  // saved intake, never created a seat) gets no files at all. Once ANYTHING is
  // configured, the per-file guarantee below takes over — a configured-but-quiet
  // week still gets whats-new.json/takes--<slug>.json, just with empty arrays,
  // so the agent can tell "quiet week" from "broken pipe".
  const hasAnything =
    company !== null ||
    profileData.company !== null ||
    intakes.length > 0 ||
    seats.length > 0 ||
    news.length > 0 ||
    takes.length > 0;
  if (!hasAnything) return [];

  const files: AgentServiceContextFile[] = [];
  const runKey = randomUUID();

  // 0. Prior batches first — the anti-duplication ground truth for this run.
  if (agentName) {
    files.push(...(await priorBatchFiles(clientId, agentName, runKey)));
  }

  // 1. The intake forms + learning logs, one markdown file.
  const seatSections = await Promise.all(
    seats.map(async (seat) => {
      const intake = await getAgentIntake(clientId, "x", seat.id);
      return [
        intakeSection(`Seat — ${seat.name}`, intake, profileData.seats[seat.id] ?? null, seat),
        feedbackSection(seat.id, `Learning log — ${seat.name}'s seat`, feedback),
      ].join("\n\n");
    }),
  );
  const intakeMd = [
    "# X agent — portal-collected client data",
    "",
    "SOURCE OF TRUTH: this file is the portal's live X intake for this client. If the",
    "baked repo contains older copies under clients/<slug>/internal/x-agent/ or",
    "clients/<slug>/config.json (x block), THIS FILE WINS on any disagreement.",
    "Voice, pillars, cadence, language and launch-vs-ongoing are BUILT by the agent",
    "(onboarding profile + the account's own posts + the edit loop) — they are not",
    "collected here and must never be asked of the client.",
    "",
    intakeSection("Company page", company, profileData.company),
    "",
    feedbackSection("company", "Learning log — company page", feedback),
    "",
    ...seatSections,
    "",
    feedbackSection("program", "Program feedback (applies to EVERY account)", feedback),
  ].join("\n");
  files.push({
    name: "x-portal-intake.md",
    url: await upload(clientId, runKey, "x-portal-intake.md", intakeMd, "text/markdown"),
    content_type: "text/markdown",
    description:
      "Portal-collected X intake: company page + seats (handles, off-limits, rosters) and per-account learning logs. Overrides any older x-agent intake files in the repo.",
  });

  // 2. Per-seat AI-built voice profile, one file per seat that has one.
  for (const seat of seats) {
    const profile = voiceProfiles.find((p) => p.seatId === seat.id);
    if (!profile) continue;
    const name = `voice-profile--${seat.slug}.md`;
    files.push({
      name,
      url: await upload(clientId, runKey, name, profile.content, "text/markdown"),
      content_type: "text/markdown",
      description: `${seat.name}'s AI-built voice profile, swept from their own handle/posts by the setup run. Read-only reference — never asked of the client.`,
    });
  }

  // 3. The company news drop, in the exact whats-new.json shape the internal
  // connector reads. Always emitted once anything is configured (even zero
  // entries this week) — a missing file must never look like a quiet one.
  const updates = news.map((n) => ({
    title: n.title,
    date: n.date,
    ...(n.detail ? { detail: n.detail } : {}),
    ...(n.url ? { url: n.url } : {}),
    ...(n.type ? { type: n.type } : {}),
  }));
  files.push({
    name: "whats-new.json",
    url: await upload(clientId, runKey, "whats-new.json", JSON.stringify({ updates }, null, 2), "application/json"),
    content_type: "application/json",
    description:
      "The client's live company news drop (portal 'What's new' box) in the engine's whats-new.json shape, always present — an empty `updates` array means a quiet week, not a broken pipe. Overrides any repo copy.",
  });

  // 4. One takes file per seat, in the engine's takes.json shape — always
  // emitted for every seat, empty `takes` array when that seat has none this
  // week, for the same quiet-week-vs-broken-pipe reason as whats-new.json.
  for (const seat of seats) {
    const seatTakes = takes.filter((t) => t.seatId === seat.id);
    const body = JSON.stringify(
      {
        takes: seatTakes.map((t) => ({
          take: t.take,
          date: t.date,
          ...(t.topic ? { topic: t.topic } : {}),
          ...(t.url ? { url: t.url } : {}),
        })),
      },
      null,
      2,
    );
    const name = `takes--${seat.slug}.json`;
    files.push({
      name,
      url: await upload(clientId, runKey, name, body, "application/json"),
      content_type: "application/json",
      description: `${seat.name}'s live takes drop (portal 'Your takes & topics' box) in the engine's takes.json shape, always present. Overrides any repo copy.`,
    });
  }

  return files;
}
