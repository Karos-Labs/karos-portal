import "server-only";

/**
 * Newsletter v2 run-time context: the client's stored intake and the five data
 * files the writer and manager read, serialized to storage and attached to the
 * run as `context_files`.
 *
 * ── WHY THIS EXISTS, AND WHY THE STAKES ARE THE HIGHEST OF THE THREE ──────
 *
 * Same ephemeral-workspace problem as LinkedIn and Reddit: the runner clones the
 * lab repo fresh and the container is destroyed, so anything the run writes into
 * `clients/<slug>/skills/newsletter-agent-v2/` is discarded. The newsletter's v2
 * design leans on those files harder than either predecessor — the writer CLAIMS
 * an issue number in the index at step 01 and flips it to shipped at step 11, the
 * topic pool records what has already been written about, and the voice card is
 * built once at setup precisely so it is not re-derived every week.
 *
 * Lose a LinkedIn ledger and a subject repeats. Lose a Reddit rules audit and an
 * account is banned. Lose the issue index and the next run claims a number that
 * already went out, so real subscribers receive a second "Issue 004" — which is
 * the exact v1 defect the framework opens with: numbering counted a folder that
 * never existed, and all three real issues were numbered by hand.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * The BRAND FILE. It lives at `clients/<slug>/skills/newsletter-agent/<slug>.json`
 * and is read live by v1 and by the blog agent as well as v2; the setup framework
 * names setup as its single writer of record and forbids renaming or removing a
 * field. Mirroring it into portal state would create a second copy with no owner,
 * which is the split-brain the framework's own §6 is written to avoid.
 */

import { randomUUID } from "crypto";
import { getAgentIntake, listNewsletterAgentState } from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { AgentIntake, NewsletterAgentState } from "@/lib/types";
import { NEWSLETTER_WRITER_V2_KEY } from "@/lib/custom-agent-launch";

/**
 * Every newsletter v2 skill. The writer is the agent; the other three are its
 * steps and are hidden from rosters by `parentKey`.
 *
 * All four are fed the same context, and the setup skill is the reason: it is the
 * job that CREATES these files, so it needs the intake, and on a re-run it needs
 * to see what already exists rather than re-seeding an index that has shipped
 * issues in it.
 */
export function isNewsletterAgent(agentKey: string): boolean {
  return (
    agentKey === NEWSLETTER_WRITER_V2_KEY ||
    agentKey === "karos-newsletter-setup-v2" ||
    agentKey === "karos-newsletter-manager-v2" ||
    agentKey === "karos-compliance-lock-v2"
  );
}

/** The v2 SETUP specifically — the only one that runs before state exists. */
export function isNewsletterSetupV2(agentKey: string): boolean {
  return agentKey === "karos-newsletter-setup-v2";
}

/**
 * Whether the client's newsletter intake is saved.
 *
 * Gated on the company row exactly like the other three families, and for the
 * same deliberate portal policy: saving the form with empty answers satisfies it,
 * because the run dialog renders the form inline and pressing Run the first time
 * IS the form. Newsletter never has a seat row — an issue goes out from the
 * company, never from a person — so `seatId: null` is the only shape.
 */
export async function hasNewsletterAgentIntake(clientId: string): Promise<boolean> {
  return (await getAgentIntake(clientId, "newsletter", null)) !== null;
}

/**
 * Whether this client has been through v2 setup — i.e. whether the writer has
 * anything to write from.
 *
 * Asked of the ISSUE INDEX, and that choice matters. The framework's setup §2
 * says a client is not set up until the last step writes its readiness verdict,
 * and of the five files the index is the one the writer cannot proceed without:
 * step 01 claims a number in it before any work happens. A client with a voice
 * card but no index would fail at the first step of a run they were charged for.
 */
export async function hasNewsletterV2Setup(clientId: string): Promise<boolean> {
  const state = await listNewsletterAgentState(clientId);
  return state.some((row) => row.kind === "issue-index" && row.content.trim().length > 0);
}

/* ─────────────────── how each state file is re-attached ─────────────────── */

const STATE_FILES: Record<
  NewsletterAgentState["kind"],
  { name: string; contentType: string; description: string }
> = {
  "issue-index": {
    name: "issue-index.json",
    contentType: "application/json",
    description:
      "THE NUMBERING AUTHORITY AND THE DEDUP MEMORY, and the portal's copy is the live one — the baked repo's is stale. Claim the next number here at step 01 by appending a row keyed by the number itself, BEFORE any other work, and flip it to shipped at step 11. Read it live for what has already gone out. Two runs must never both claim the same number: a duplicate here sends a second copy of an issue to a real subscriber list. Deliver the whole updated file back.",
  },
  "topic-pool": {
    name: "topic-pool.json",
    contentType: "application/json",
    description:
      "The editorial runway: every topic with its pillar, provenance and status. THIS IS THE LIVE COPY. Pick from the unused rows, mark what you consume as used at step 11, and deliver the whole updated file back. An empty pool is a HELD run, never an improvised topic — a pool row carries provenance and an invented subject does not.",
  },
  "voice-card": {
    name: "voice-card.md",
    contentType: "text/markdown",
    description:
      "The style target, built ONCE at setup from the client's own past newsletters. Do not re-derive it during a run — that weekly re-derivation from files that never change is the v1 defect this file exists to end. Match it when drafting; the manager refreshes it only when new references arrive.",
  },
  "scan-topics": {
    name: "scan-topics.json",
    contentType: "application/json",
    description:
      "The niche watch-list the seven-day scan searches. Pass it to the scan EXPLICITLY rather than letting the carried code look topics up itself. This is what to search; the topic pool is what to write about — different files, different sources, not interchangeable.",
  },
  "content-foundation": {
    name: "CONTENT-FOUNDATION.md",
    contentType: "text/markdown",
    description:
      "The editorial brain: pillars, voice rules, the compliance block, keyword targets. Read the compliance section together with the brand file's — those two together are the rules the step-08 sweep enforces and the step-09 code gate refuses on. Read by heading text, never by section number: the numbering differs per client.",
  },
};

/* ────────────────────────── the client's own answers ────────────────────── */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function intakeMd(intake: AgentIntake | null): string {
  const lines: string[] = [
    "# Newsletter agent — the portal's live client data",
    "",
    "SOURCE OF TRUTH for what the CLIENT told us. It overrides any older copy in",
    "the baked repo on any disagreement.",
    "",
    "Everything editorial — the pillars, the voice, the topic pool, the watch-list —",
    "is BUILT by setup from the onboarding documents and lives in the attached data",
    "files. It is never collected from the client and must never be asked of them.",
    "What is here is only what setup could not derive.",
    "",
  ];
  if (!intake) {
    lines.push("## No intake stored yet", "- The client has not filled the newsletter form.");
    return lines.join("\n");
  }
  lines.push("## Scheduling");
  // The framework is explicit that "no day chosen" is a real answer and that
  // three existing files wrongly assert Tuesday. Printing a default here would
  // reintroduce exactly that.
  lines.push(
    intake.preferredWeekday === null || intake.preferredWeekday === undefined
      ? "- Preferred send day: NOT CHOSEN YET. Do not assume one, and do not print a day anywhere."
      : `- Preferred send day: ${WEEKDAYS[intake.preferredWeekday] ?? "unknown"}`,
  );
  lines.push(
    `- Email platform: ${intake.espName?.trim() || "not stated. Recorded, never required — we prepare the issue and the client sends it from their own tool."}`,
  );
  lines.push("", "## Editorial");
  if (intake.audienceNote?.trim()) {
    lines.push(`- Who this is written for, in their words: ${intake.audienceNote.trim()}`);
  }
  lines.push("", "## Compliance");
  const banned = (intake.bannedPhrases ?? []).map((p) => p.trim()).filter(Boolean);
  lines.push(
    banned.length > 0
      ? `- Phrases this client may NEVER print, on top of the house rules:\n${banned.map((p) => `  - ${p}`).join("\n")}`
      : "- No client-specific banned phrases on file. The house rules still apply in full.",
  );
  if (intake.openComplianceNote?.trim()) {
    lines.push(
      "",
      "### An open question the client has not answered",
      "",
      intake.openComplianceNote.trim(),
      "",
      "Carry this as a REVIEW FLAG on every issue until it is answered: lead with it",
      "in about.txt so the person who sends actually reads it before sending.",
    );
  }
  return lines.join("\n");
}

async function upload(clientId: string, runKey: string, name: string, body: string, contentType: string) {
  const { url } = await uploadBytes({
    bytes: Buffer.from(body, "utf8"),
    path: `clients/${clientId}/newsletter-agent/portal-context/${runKey}/${name}`,
    contentType,
  });
  return url;
}

/**
 * Build the newsletter agent's portal-data context files for one run. Returns []
 * when there is nothing at all to say, so callers can append unconditionally.
 *
 * SETUP GETS THE STATE TOO, which is not an oversight. Setup is re-runnable by
 * design, and its own framework is emphatic that a re-run must VERIFY rather than
 * re-seed — above all that the issue index is never re-seeded once it holds rows,
 * because re-seeding after v2 has shipped 004 and 005 would erase them. It cannot
 * honour that rule without being shown what already exists.
 */
export async function buildNewsletterAgentContextFiles(
  clientId: string,
  agentName?: string,
): Promise<AgentServiceContextFile[]> {
  const [intake, state] = await Promise.all([
    getAgentIntake(clientId, "newsletter", null),
    listNewsletterAgentState(clientId),
  ]);
  if (!intake && state.length === 0) return [];

  const files: AgentServiceContextFile[] = [];
  const runKey = randomUUID();

  const md = intakeMd(intake);
  files.push({
    name: "newsletter-portal-intake.md",
    url: await upload(clientId, runKey, "newsletter-portal-intake.md", md, "text/markdown"),
    content_type: "text/markdown",
    description:
      "The portal's live newsletter intake: the client's chosen send day (or that they have not chosen one), their email platform, their audience note, their banned phrases, and any open compliance question that must ride every issue as a review flag. Overrides older copies in the repo.",
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

  // Named so the run cannot mistake absence for emptiness. An issue index that is
  // ABSENT means setup has not run; an index that is EMPTY means a set-up client
  // with no issues yet, and the first is a reason to stop while the second is a
  // reason to start at 001.
  if (agentName && !state.some((r) => r.kind === "issue-index")) {
    files.push({
      name: "newsletter-state-absent.md",
      url: await upload(
        clientId,
        runKey,
        "newsletter-state-absent.md",
        [
          "# No newsletter state has been captured for this client yet",
          "",
          "There is no issue index, so SETUP HAS NOT RUN (or its output was never",
          "captured). This is different from an index that exists and is empty: that",
          "would be a set-up client whose first issue is 001.",
          "",
          "A writer run must not invent a starting number from this. Report",
          "blocked_intake naming the missing setup.",
        ].join("\n"),
        "text/markdown",
      ),
      content_type: "text/markdown",
      description:
        "Marks that no newsletter state exists yet — setup has not run. Absent state is not empty state; do not start numbering from a guess.",
    });
  }

  return files;
}
