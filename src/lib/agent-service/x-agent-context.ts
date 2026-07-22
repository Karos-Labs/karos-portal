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
  getAsset,
  listAgentIntake,
  listClientSeats,
  listJobs,
  listXDraftFeedback,
  listXNewsUpdates,
  listXTakes,
} from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { AgentIntake, ClientSeat, XDraftFeedback } from "@/lib/types";

/** The imported lab-manifest key of the X agent's customAgents doc. */
export function isXAgent(agentKey: string): boolean {
  return agentKey === "karos-x-agent";
}

/**
 * Whether the client has any X intake stored yet — the company page or at
 * least one seat. The X agent runs ON this data (voice, off-limits, roster,
 * takes); with none of it a run would draft from onboarding alone and miss the
 * point, so the submit cores hard-gate on this.
 */
export async function hasXAgentIntake(clientId: string): Promise<boolean> {
  const [intakes, seats] = await Promise.all([listAgentIntake(clientId, "x"), listClientSeats(clientId)]);
  return intakes.length > 0 || seats.length > 0;
}

/** Most recent feedback rows serialized per account (the Learning Log source). */
const FEEDBACK_ROWS_PER_ACCOUNT = 30;

function intakeSection(label: string, intake: AgentIntake | null, seat?: ClientSeat): string {
  const lines: string[] = [`## ${label}`];
  if (seat) lines.push(`- Person: ${seat.name} (slug: ${seat.slug})`);
  if (!intake) {
    lines.push("- No intake stored yet.");
    return lines.join("\n");
  }
  lines.push(
    `- Handle: ${intake.handle ?? (seat ? "PENDING (seat drafts only — cannot post or self-sample)" : "none yet (launch mode)")}`,
  );
  if (intake.comeAcross) lines.push(`- How they want to come across on X: ${intake.comeAcross}`);
  lines.push(`- Never post (off-limits): ${intake.offLimits || "(none given — house rules still apply)"}`);
  lines.push(
    intake.roster.length > 0
      ? `- Engagement roster (activates the engagement lane): ${intake.roster.join(", ")}`
      : "- Engagement roster: none given — engagement lane stays off.",
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
      return `- ${when}: posted with edits${ref}. Final text used: ${r.finalText ?? "(not captured)"}`;
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
  const [seats, intakes, news, takes, feedback] = await Promise.all([
    listClientSeats(clientId),
    listAgentIntake(clientId, "x"),
    listXNewsUpdates(clientId),
    listXTakes(clientId),
    listXDraftFeedback(clientId),
  ]);
  const company = intakes.find((i) => i.seatId === null) ?? null;
  const hasAnything =
    company !== null || intakes.length > 0 || seats.length > 0 || news.length > 0 || takes.length > 0;
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
        intakeSection(`Seat — ${seat.name}`, intake, seat),
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
    intakeSection("Company page", company),
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

  // 2. The company news drop, in the exact whats-new.json shape the internal connector reads.
  if (news.length > 0) {
    const updates = news.map((n) => ({
      title: n.title,
      date: n.date,
      ...(n.detail ? { detail: n.detail } : {}),
      ...(n.url ? { url: n.url } : {}),
      ...(n.type ? { type: n.type } : {}),
    }));
    const body = JSON.stringify({ updates }, null, 2);
    files.push({
      name: "whats-new.json",
      url: await upload(clientId, runKey, "whats-new.json", body, "application/json"),
      content_type: "application/json",
      description:
        "The client's live company news drop (portal 'What's new' box) in the engine's whats-new.json shape. Overrides any repo copy.",
    });
  }

  // 3. One takes file per seat that has takes, in the engine's takes.json shape.
  for (const seat of seats) {
    const seatTakes = takes.filter((t) => t.seatId === seat.id);
    if (seatTakes.length === 0) continue;
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
      description: `${seat.name}'s live takes drop (portal 'Your takes & topics' box) in the engine's takes.json shape. Overrides any repo copy.`,
    });
  }

  return files;
}
