import "server-only";

/**
 * Reddit agent (e15) run-time context: serializes the portal-collected Reddit
 * intake (the company-account form, the learning log, and the per-subreddit
 * rules the client's own feedback has earned) into files uploaded to storage
 * and attached to the run as context_files — the same injection path the X
 * (e13) and LinkedIn (e10) agents use. Purely additive: agents other than the
 * Reddit agent never hit this module, and a run with nothing stored attaches
 * nothing.
 *
 * Two Reddit-specific jobs this module does that its siblings do not:
 *
 * 1. It applies the contract's promo-downgrade rule BEFORE the run rather than
 *    leaving it to the agent's judgment: two or more "too promotional" or
 *    "against the rules" outcomes against one subreddit downgrade that
 *    subreddit to value-only, and a removal is logged as never-repeat. The
 *    weekly manager does this lab-side from its own ledger, but the portal's
 *    feedback rows are the only copy of the client's outcomes, and the runner
 *    workspace is ephemeral.
 * 2. It injects prior batches as the anti-duplication ground truth. Reddit
 *    drafts one reply per run on a daily cadence, so a run needs more history
 *    than a weekly batch agent does — the ledger guard is per question
 *    pattern, per subreddit and per thread over a 30-day window.
 */

import { randomUUID } from "crypto";
import {
  getAgentIntake,
  getAsset,
  listCustomAgents,
  listJobs,
  listRedditDraftFeedback,
} from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { AgentIntake, RedditDraftFeedback } from "@/lib/types";

/**
 * The imported lab-manifest key of the Reddit agent's customAgents doc. Shared
 * and unbound: one doc serves every client, like the X agent, so
 * perClientAgentSlug(key) is null and every client's agents page lists it.
 *
 * If the lab ever emits per-client Reddit instances (karos-reddit-…-<slug>),
 * widening this predicate is NOT enough on its own — perClientAgentSlug in
 * custom-agent-launch.ts must learn the prefix in the same change, or the
 * instance is offered to every client instead of its own.
 */
export function isRedditAgent(agentKey: string): boolean {
  return agentKey === "karos-reddit-agent";
}

/**
 * Whether the client's Reddit intake is set up enough to run: the company
 * account form must be SAVED. The company page is the floor for every
 * intake-driven agent and anything else is additive — a shared ClientSeat says
 * nothing about Reddit, because one person keeps one seat across agents and
 * theirs may have been created for X or LinkedIn. Saving the form with empty
 * answers satisfies the gate, which is the deliberate portal policy: the lab
 * contract would allow a run from onboarding alone, but this portal wants the
 * data seen first.
 *
 * The `ready` flag on the agents page is derived from this same
 * agentIntake(clientId, "reddit", null) row; a drift between the two silently
 * un-gates a run.
 */
export async function hasRedditAgentIntake(clientId: string): Promise<boolean> {
  return (await getAgentIntake(clientId, "reddit", null)) !== null;
}

/** Most recent feedback rows serialized (the Learning Log source). */
const FEEDBACK_ROWS = 40;
/** Outcomes against one subreddit that force it down to value-only. */
const PROMO_STRIKES_TO_DOWNGRADE = 2;

function accountSection(intake: AgentIntake | null): string {
  const lines: string[] = ["## The account we draft as"];
  if (!intake) {
    lines.push("- No Reddit intake stored yet.");
    return lines.join("\n");
  }
  lines.push(
    `- Account: ${intake.handle ?? "none nominated yet — draft in WARMING mode and state in the poster note that nothing can be posted until a real, aged account is confirmed"}`,
  );
  lines.push(
    `- Account history (client's own read): ${intake.accountHistory || "not given — assume NO usable history and stay in warming mode (value-only, zero product mentions)"}`,
  );
  lines.push(
    intake.mode
      ? `- Program mode: ${intake.mode.toUpperCase()} (client-set). ${
          intake.mode === "warming"
            ? "Zero product mentions in any draft, in any subreddit."
            : "A disclosed mention is allowed ONLY where that subreddit's rules permit it and it is genuinely the best answer."
        }`
      : "- Program mode: not set — decide from the account history above and default to WARMING (value-only), the safe direction.",
  );
  lines.push(
    intake.subreddits?.length
      ? `- Subreddits the client already participates in (a research STARTING POINT, not the roster): ${intake.subreddits.join(", ")}`
      : "- Subreddits the client already participates in: none given — derive the roster entirely from the audience and category.",
  );
  lines.push(
    intake.offLimitsSubreddits?.length
      ? `- OFF-LIMITS subreddits (binding, never draft for these — the client was burned or banned there): ${intake.offLimitsSubreddits.join(", ")}`
      : "- Off-limits subreddits: none given.",
  );
  lines.push(
    intake.disclosurePosture
      ? `- Disclosure wording the client is comfortable with (use this verbatim as the disclosure line on any draft that carries a mention): ${intake.disclosurePosture}`
      : "- Disclosure wording: none given — if a mention is ever allowed, write a plain one-line disclosure and flag it for approval.",
  );
  lines.push(`- Never say (off-limits): ${intake.offLimits || "(none given — house rules still apply)"}`);
  return lines.join("\n");
}

function feedbackSection(rows: RedditDraftFeedback[], account: string, label: string): string {
  const scoped = rows.filter((r) => r.account === account).slice(0, FEEDBACK_ROWS);
  if (scoped.length === 0) return `## ${label}\n- No feedback yet.`;
  const lines = scoped.map((r) => {
    const when = new Date(r.createdAt).toISOString().slice(0, 10);
    const ref = r.draftRef ? ` on "${r.draftRef}"` : "";
    const where = r.subreddit ? ` in ${r.subreddit}` : "";
    if (r.action === "posted") return `- ${when}: posted as drafted${where}${ref}.`;
    if (r.action === "posted_with_edits") {
      return `- ${when}: posted WITH EDITS${where}${ref}. Diff our draft against what they actually posted and carry the voice delta forward. Final text used: ${r.finalText ?? "(not captured)"}`;
    }
    if (r.action === "note") return `- ${when}: client note${ref}: ${r.reason ?? "(empty)"}`;
    if (r.action === "edit_request") {
      return `- ${when}: change requested${where}${ref}: ${r.reason ?? "(empty)"} — this is a STANDING instruction; apply it whenever this subject or style comes up again.`;
    }
    return `- ${when}: NOT posted${where}${ref}. Reason: ${r.reasonCode ?? "unspecified"}${r.reason ? ` — ${r.reason}` : ""}`;
  });
  return `## ${label}\n${lines.join("\n")}`;
}

/**
 * The per-subreddit verdicts the client's own outcomes have earned. This is the
 * contract's mechanical rule, already applied — the agent does not get to
 * re-litigate it.
 */
function subredditRulesSection(rows: RedditDraftFeedback[]): string {
  const strikes = new Map<string, { promo: number; removed: number; wrongSub: number; died: number }>();
  for (const row of rows) {
    if (row.action !== "not_posted" || !row.subreddit) continue;
    const tally = strikes.get(row.subreddit) ?? { promo: 0, removed: 0, wrongSub: 0, died: 0 };
    if (row.reasonCode === "too_promotional" || row.reasonCode === "rules") tally.promo += 1;
    if (row.reasonCode === "removed") tally.removed += 1;
    if (row.reasonCode === "wrong_subreddit") tally.wrongSub += 1;
    if (row.reasonCode === "thread_died") tally.died += 1;
    strikes.set(row.subreddit, tally);
  }
  if (strikes.size === 0) {
    return "## Per-subreddit rules earned from this client's outcomes\n- Nothing yet — no draft has come back rejected.";
  }
  const lines = [...strikes.entries()]
    .sort((a, b) => b[1].promo + b[1].removed - (a[1].promo + a[1].removed))
    .map(([subreddit, t]) => {
      const notes: string[] = [];
      if (t.promo >= PROMO_STRIKES_TO_DOWNGRADE) {
        notes.push(
          `DOWNGRADED TO VALUE-ONLY (${t.promo} promotional/rules rejections). No product mention here, ever, regardless of what the subreddit's public rules allow.`,
        );
      } else if (t.promo > 0) {
        notes.push(`${t.promo} promotional/rules rejection so far — one more downgrades this subreddit to value-only.`);
      }
      if (t.removed > 0) {
        notes.push(
          `${t.removed} answer REMOVED or heavily downvoted here — the strongest negative signal there is. Never repeat that answer pattern in this subreddit.`,
        );
      }
      if (t.wrongSub > 0) notes.push(`${t.wrongSub} rejected as the wrong subreddit for this client.`);
      if (t.died > 0) notes.push(`${t.died} rejected because the thread went quiet — pick fresher threads here.`);
      return `- ${subreddit}: ${notes.join(" ")}`;
    });
  return `## Per-subreddit rules earned from this client's outcomes\n${lines.join("\n")}`;
}

async function upload(clientId: string, runKey: string, name: string, body: string, contentType: string) {
  const { url } = await uploadBytes({
    bytes: Buffer.from(body, "utf8"),
    path: `clients/${clientId}/reddit-agent/portal-context/${runKey}/${name}`,
    contentType,
  });
  return url;
}

/**
 * How many prior drafts each run receives. Higher than the weekly agents' 3:
 * Reddit drafts ONE reply per run on a daily cadence, so three batches is
 * three days and the contract's no-repeat guard spans 30.
 */
const PRIOR_BATCHES = 12;
const PRIOR_BATCH_MAX_CHARS = 8_000;

/**
 * Prior portal-run drafts, newest first. The runner workspace is ephemeral —
 * the ledger appends a run makes inside it are DISCARDED with the workspace —
 * so run-over-run anti-duplication only works if each run RECEIVES the previous
 * drafts. The webhook stores each run's drafts markdown as the job asset's
 * content; that is the durable copy re-injected here.
 *
 * Scoped to ALL of the client's Reddit agents, not just the launching one: the
 * lab contract shares ONE ledger across every Reddit generator for a client.
 */
async function priorBatchFiles(
  clientId: string,
  agentName: string,
  runKey: string,
): Promise<AgentServiceContextFile[]> {
  const redditAgentNames = new Set(
    (await listCustomAgents()).filter((a) => isRedditAgent(a.key)).map((a) => a.name),
  );
  redditAgentNames.add(agentName);
  const jobs = (await listJobs({ clientId }))
    .filter(
      (j) =>
        j.agentId === "agent-service" &&
        j.external?.taskType === "custom" &&
        redditAgentNames.has(j.agentName) &&
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
      description: `A previous Reddit draft for this client (${when}). Treat its thread, subreddit, question pattern, angle and phrasing as ALREADY USED — never answer that thread again, and do not repeat the same question pattern in the same subreddit within 30 days. The baked repo ledger is STALE for portal runs; these files are the durable memory.`,
    });
  }
  return files;
}

/**
 * Builds the Reddit agent's portal-data context files for one run. Returns []
 * when nothing is stored, so callers can append unconditionally. `agentName`
 * (the customAgents doc name) scopes the prior-batch lookup.
 */
export async function buildRedditAgentContextFiles(
  clientId: string,
  agentName?: string,
): Promise<AgentServiceContextFile[]> {
  const [intake, feedback] = await Promise.all([
    getAgentIntake(clientId, "reddit", null),
    listRedditDraftFeedback(clientId),
  ]);
  if (!intake && feedback.length === 0) return [];

  const files: AgentServiceContextFile[] = [];
  const runKey = randomUUID();

  // Prior drafts first — the anti-duplication ground truth for this run.
  if (agentName) files.push(...(await priorBatchFiles(clientId, agentName, runKey)));

  const intakeMd = [
    "# Reddit agent — portal-collected client data",
    "",
    "SOURCE OF TRUTH: this file is the portal's live Reddit intake for this client.",
    "If the baked repo contains older copies under clients/<slug>/internal/reddit-agent/",
    "or clients/<slug>/internal/reddit/config.json, THIS FILE WINS on any disagreement.",
    "",
    "The subreddit roster, the recurring-question pool, the answer formulas and the",
    "voice profile are BUILT by you from the client's audience and category — they are",
    "not collected here and must never be asked of the client. What is here is only",
    "what you cannot discover: which account we draft as, an honest read of its",
    "history, where the client has already been burned, and their disclosure wording.",
    "",
    "DRAFT-ONLY, ALWAYS: a human posts every reply from their own account. There is no",
    "posting credential in this portal and no auto-post path. Never imply otherwise in",
    "a poster note.",
    "",
    accountSection(intake),
    "",
    subredditRulesSection(feedback),
    "",
    feedbackSection(feedback, "company", "Learning log — this account"),
    "",
    feedbackSection(feedback, "program", "Program feedback (applies to every account)"),
  ].join("\n");

  files.push({
    name: "reddit-portal-intake.md",
    url: await upload(clientId, runKey, "reddit-portal-intake.md", intakeMd, "text/markdown"),
    content_type: "text/markdown",
    description:
      "Portal-collected Reddit intake: the account we draft as, its history, the program mode, off-limits subreddits, disclosure wording, the per-subreddit verdicts this client's own outcomes have earned, and the learning log. Overrides any older reddit-agent files in the repo.",
  });

  return files;
}
