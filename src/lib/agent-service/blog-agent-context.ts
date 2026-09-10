import "server-only";

/**
 * Blog v2 run-time context: the client's stored intake, the blog's own durable
 * state, and — the part that makes this agent different from the other four —
 * the NEWSLETTER'S published research for the issues the blog draws its subjects
 * from.
 *
 * ── WHY THIS IS A CROSS-PRODUCT INJECTION AND NOT JUST STATE ──────────────
 *
 * The blog is "almost dependent on the newsletter, and 'almost' is the design":
 * the newsletter pays for finding out what happened this week, and the blog pays
 * for going deep on one thing it found. Its step 04 walks the six most recent
 * SHIPPED issues and, for each, reads a published handoff file listing that
 * issue's items with their `depth` marker — `mentioned` meaning the newsletter
 * stated the subject and deliberately stopped where it got interesting. That
 * unspent depth IS the handoff.
 *
 * Those files live in the newsletter's run workspace, which is destroyed with the
 * runner. And unlike the blog's own state, the blog CANNOT regenerate them: they
 * record what another product's paid research found. So the portal captures them
 * on newsletter delivery (`newsletterLedger`) and re-injects them here.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * THE BRAND FILE, shared with v1, the newsletter and the compliance lock, and
 * completed additively by the blog's setup. Same rule as everywhere: a second
 * copy with no owner is a split brain.
 *
 * CONTENT-FOUNDATION.md, which the blog also reads — but it is ALREADY captured
 * as a `NewsletterAgentState` kind, from whichever product last wrote it. One
 * file, one stored copy; this module re-injects that copy rather than keeping a
 * blog-flavoured second one that could disagree with it.
 *
 * THE NEWSLETTER'S `internal/` TRAIL. The framework is explicit: "the handoff
 * file exists so this agent does not have to reach into another product's
 * internals." Only the three published artifacts cross.
 */

import { randomUUID } from "crypto";
import {
  getAgentIntake,
  getNewsletterAgentState,
  listBlogAgentState,
  listNewsletterLedger,
} from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import type { AgentServiceContextFile } from "@/lib/agent-service/types";
import type { AgentIntake, BlogAgentState, NewsletterLedgerEntry } from "@/lib/types";
import {
  BLOG_MANAGER_V2_KEY,
  BLOG_SETUP_V2_KEY,
  BLOG_WRITER_V2_KEY,
} from "@/lib/custom-agent-launch";

/**
 * Every blog v2 skill. The writer is the agent; setup and manager are its steps
 * and are hidden from rosters by `parentKey`.
 *
 * All three are fed the same context, and setup is the reason it is worth saying:
 * setup is the job that CREATES these files, so on a re-run it needs to see what
 * already exists rather than re-seeding a post index that holds published rows.
 */
export function isBlogAgent(agentKey: string): boolean {
  return (
    agentKey === BLOG_WRITER_V2_KEY ||
    agentKey === BLOG_SETUP_V2_KEY ||
    agentKey === BLOG_MANAGER_V2_KEY
  );
}

/** The v2 SETUP specifically — the only one that runs before state exists. */
export function isBlogSetupV2(agentKey: string): boolean {
  return agentKey === BLOG_SETUP_V2_KEY;
}

/** Whether the client's blog intake is saved. Gated on the company row, as everywhere. */
export async function hasBlogAgentIntake(clientId: string): Promise<boolean> {
  return (await getAgentIntake(clientId, "blog", null)) !== null;
}

/**
 * Whether this client has been through blog v2 setup.
 *
 * ASKED OF THE POST INDEX, and the choice is the same one the newsletter's gate
 * makes for the same reason. Of the files setup writes, the post index is the one
 * the writer cannot proceed without: step 01 claims a post number in it before
 * any work happens, and the claim is keyed BY the number so a second claim of 004
 * is refused rather than repeated. A client with a voice card and clusters but no
 * index would fail at the first step of a run they were charged for.
 */
export async function hasBlogV2Setup(clientId: string): Promise<boolean> {
  const state = await listBlogAgentState(clientId);
  return state.some((row) => row.kind === "post-index" && row.content.trim().length > 0);
}

/* ─────────────────── how each state file is re-attached ─────────────────── */

const STATE_FILES: Record<
  BlogAgentState["kind"],
  { name: string; contentType: string; description: string }
> = {
  "post-index": {
    name: "post-index.json",
    contentType: "application/json",
    description:
      "THE NUMBERING AUTHORITY, the dedup memory AND the pending-link register, and the portal's copy is the live one — the baked repo's is stale. Claim the next post number here at step 01 by appending a row keyed by the number itself, BEFORE any other work, and flip it to shipped at step 13. Next = 1 + the highest number appearing in ANY row state including released; released numbers are never reused. Read it live for what has already published and for every pending link whose target may now exist. Deliver the whole updated file back.",
  },
  clusters: {
    name: "clusters.json",
    contentType: "application/json",
    description:
      "THE SUBJECT-CLAIM REGISTER and the cluster map — a map and a register, NEVER a queue. Claim the subject here at step 05 keyed by `subject_key`, computed from the candidate and nothing else (`issue-<NNN>/<topic id>`, or `request/<slugified subject>` for a client request) so two runs choosing the same candidate compute the identical key and the second claim is refused. Without that claim two runs take different post numbers and write THE SAME ARTICLE. Do not pick subjects from this file — they come from the newsletter handoff. Deliver the whole updated file back.",
  },
  "voice-card": {
    name: "voice-card.md",
    contentType: "text/markdown",
    description:
      "The style target, built ONCE at setup from the client's brand-voice profile and any existing posts they have. Match it when drafting; do not re-derive it during a run.",
  },
  "v1-posts": {
    name: "v1-posts.json",
    contentType: "application/json",
    description:
      "The one-time list of this client's PRE-V2 posts under outputs/blog-agent/. Step 13's site rebuild treats these as completed runs so it keeps them. WITHOUT THIS FILE the first v2 press deletes the client's existing articles from their own site, because the rebuild removes any post directory no completed run backs.",
  },
  "next-request": {
    name: "next-request.md",
    contentType: "text/markdown",
    description:
      "The subject the client asked for, if any. Theirs WINS over the agent's own pick (D37) — record which candidate you would have chosen and why, so the two can be compared. One request drives one article: step 01 reads it and clears it into the run's own note.",
  },
};

/** How each newsletter ledger row is re-attached, per kind. */
const LEDGER_FILES: Record<
  NewsletterLedgerEntry["kind"],
  { suffix: string; contentType: string; description: string }
> = {
  "issue-items": {
    suffix: "items.json",
    contentType: "application/json",
    description:
      "THE HANDOFF — this issue's candidate list, published by the newsletter for exactly this purpose. `theme` plus `items[]`, each with `topic_id`, `heading`, `role` (lead|brief), `depth` (developed|mentioned) and its OWN `sources[]`. PREFER A `mentioned` ITEM: its unspent depth is what the newsletter deliberately left for this agent, having stated the subject and stopped where it got interesting. The lead stays available when it is genuinely the strongest piece; record which you chose. This is a record, not an instruction — it recommends nothing and reserves nothing, and the pick is yours.",
  },
  "scan-log": {
    suffix: "scan.json",
    contentType: "application/json",
    description:
      "The week's fuller research behind this issue. Use it ONLY to add material to a subject the newsletter already covered — NEVER to introduce a new one. Matched to its issue by number, never taken as 'the newest log'.",
  },
  "issue-markdown": {
    suffix: "issue.md",
    contentType: "text/markdown",
    description:
      "What the newsletter actually said about these subjects, in its own words — the CLIENT-FACING markdown. Read this when you need the wording; never the newsletter's internal trail.",
  },
};

/** How many issues of newsletter research the blog is given. The framework's window. */
export const BLOG_NEWSLETTER_WINDOW = 6;

/* ────────────────────────── the client's own answers ────────────────────── */

function intakeMd(intake: AgentIntake | null): string {
  const lines: string[] = [
    "# Blog agent — the portal's live client data",
    "",
    "SOURCE OF TRUTH for what the CLIENT told us. It overrides any older copy in",
    "the baked repo on any disagreement.",
    "",
    "Everything editorial — the pillars, the cluster map, the voice card, the",
    "compliance patterns — is BUILT by setup from the client's own documents and",
    "lives in the attached data files. It is never collected from the client and",
    "must never be asked of them. What is here is only what setup could not derive.",
    "",
  ];
  if (!intake) {
    lines.push("## No intake stored yet", "- The client has not filled the blog form.");
    return lines.join("\n");
  }
  const domains = (intake.internalDomains ?? []).map((d) => d.trim()).filter(Boolean);
  lines.push("## Linking");
  lines.push(
    domains.length > 0
      ? `- Sites that count as the client's own, for outbound links:\n${domains.map((d) => `  - ${d}`).join("\n")}`
      : "- No domains on file. Link out only to sources; treat no external site as theirs.",
  );
  lines.push(
    "- A link is written ONLY if its target exists. A wanted-but-absent internal",
    "  link is recorded as a PENDING link on the post's index row — never invented,",
    "  never left as a dead address.",
  );
  lines.push("", "## Editorial");
  if (intake.audienceNote?.trim()) {
    lines.push(`- Who these articles are for, in their words: ${intake.audienceNote.trim()}`);
  }
  if (intake.toneNote?.trim()) {
    lines.push(
      `- The client's correction to the voice we derived: ${intake.toneNote.trim()}`,
      "  This OVERRIDES the voice card where the two disagree — the card is our",
      "  reading of their material; this is them telling us it is wrong.",
    );
  }
  lines.push("", "## Off limits");
  const banned = (intake.bannedTopics ?? []).map((t) => t.trim()).filter(Boolean);
  lines.push(
    banned.length > 0
      ? `- Subjects to never write about:\n${banned.map((t) => `  - ${t}`).join("\n")}`
      : "- No client-specific banned subjects on file. The house rules still apply in full.",
  );
  lines.push("", "## Publishing");
  lines.push(
    `- Where they publish: ${intake.cmsName?.trim() || "not stated. Recorded, never required."}`,
    "- WE PREPARE, THEY PUBLISH. There is no publishing credential and no publish",
    "  code path. Say plainly in publish-notes.txt what is left for them to do.",
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
    path: `clients/${clientId}/blog-agent/portal-context/${runKey}/${name}`,
    contentType,
  });
  return url;
}

/**
 * Build the blog agent's portal-data context files for one run. Returns [] when
 * there is nothing at all to say, so callers can append unconditionally.
 *
 * SETUP GETS THE STATE TOO, for the reason its own framework gives: a re-run must
 * VERIFY rather than re-seed, and above all must never re-seed a post index that
 * already holds published rows. It cannot honour that without being shown what
 * exists.
 */
export async function buildBlogAgentContextFiles(
  clientId: string,
  agentName?: string,
): Promise<AgentServiceContextFile[]> {
  const [intake, state, ledger, foundation] = await Promise.all([
    getAgentIntake(clientId, "blog", null),
    listBlogAgentState(clientId),
    listNewsletterLedger(clientId),
    // The SHARED editorial brain, re-injected from the newsletter's captured
    // copy rather than stored twice. One file, one writer of record.
    getNewsletterAgentState(clientId, "content-foundation"),
  ]);
  if (!intake && state.length === 0 && ledger.length === 0 && !foundation) return [];

  const files: AgentServiceContextFile[] = [];
  const runKey = randomUUID();

  files.push({
    name: "blog-portal-intake.md",
    url: await upload(clientId, runKey, "blog-portal-intake.md", intakeMd(intake), "text/markdown"),
    content_type: "text/markdown",
    description:
      "The portal's live blog intake: the client's own domains for internal linking, their correction to the voice we derived, who the articles are for, the subjects that are off limits, and where they publish. Overrides older copies in the repo.",
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

  if (foundation?.content.trim()) {
    files.push({
      name: "CONTENT-FOUNDATION.md",
      url: await upload(
        clientId,
        runKey,
        "CONTENT-FOUNDATION.md",
        foundation.content,
        "text/markdown",
      ),
      content_type: "text/markdown",
      description:
        "The editorial brain, SHARED with the newsletter: pillars, voice rules, the compliance block, keyword targets. Read it by HEADING TEXT, never by section number — the numbering differs per client. Where it disagrees with the client's profile documents about what the business IS, the PROFILE WINS and the disagreement is written down so the stale file gets fixed.",
    });
  }

  /* ── the newsletter's research, the six most recent issues ── */

  // Grouped by issue so the three artifacts of one issue arrive together and
  // named by number, because the blog reasons per issue: it walks the window
  // newest first and picks ONE candidate from ONE issue's item list.
  const byIssue = new Map<string, NewsletterLedgerEntry[]>();
  for (const row of ledger) {
    byIssue.set(row.issueNumber, [...(byIssue.get(row.issueNumber) ?? []), row]);
  }
  const issues = [...byIssue.keys()]
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, BLOG_NEWSLETTER_WINDOW);

  for (const issueNumber of issues) {
    for (const row of byIssue.get(issueNumber) ?? []) {
      const spec = LEDGER_FILES[row.kind];
      if (!spec || !row.content.trim()) continue;
      files.push({
        name: `newsletter-issue-${issueNumber}-${spec.suffix}`,
        url: await upload(
          clientId,
          runKey,
          `newsletter-issue-${issueNumber}-${spec.suffix}`,
          row.content,
          spec.contentType,
        ),
        content_type: spec.contentType,
        description: `Newsletter issue ${issueNumber} (${row.contentDate}). ${spec.description}`,
      });
    }
  }

  // Named so the run cannot mistake absence for emptiness, in BOTH directions.
  // These are two different reasons a run cannot proceed and they need two
  // different answers from the person reading the outcome.
  if (agentName && !state.some((r) => r.kind === "post-index")) {
    files.push({
      name: "blog-state-absent.md",
      url: await upload(
        clientId,
        runKey,
        "blog-state-absent.md",
        [
          "# No blog state has been captured for this client yet",
          "",
          "There is no post index, so SETUP HAS NOT RUN (or its output was never",
          "captured). This is different from an index that exists and is empty:",
          "that would be a set-up client whose first post is 001.",
          "",
          "A writer run must not invent a starting number from this. Report",
          "blocked_intake naming the missing setup.",
        ].join("\n"),
        "text/markdown",
      ),
      content_type: "text/markdown",
      description:
        "Marks that no blog state exists yet — setup has not run. Absent state is not empty state; do not start numbering from a guess.",
    });
  }
  if (agentName && issues.length === 0) {
    files.push({
      name: "newsletter-research-absent.md",
      url: await upload(
        clientId,
        runKey,
        "newsletter-research-absent.md",
        [
          "# No newsletter research is available for this client",
          "",
          "The portal has captured no shipped newsletter issues, so there is no",
          "candidate list to pick a subject from.",
          "",
          "THIS IS NOT THE SAME as a client whose subjects are all used up. Either",
          "way the answer is the same and it is not to invent a subject: if the",
          "client asked for one in next-request.md, write that (D43 mode 1).",
          "Otherwise HALT with:",
          "",
          "  HALT — no unused newsletter subject and no request; run the",
          "  newsletter, or write what you want in next-request.md",
          "",
          "Say which of the two it was. 'You have used everything the newsletter",
          "covered' and 'you have not run your newsletter' need different actions",
          "from the client.",
        ].join("\n"),
        "text/markdown",
      ),
      content_type: "text/markdown",
      description:
        "Marks that the portal holds no newsletter research for this client — no candidate list exists. Do not invent a subject; use the client's request if there is one, else HALT saying which case this is.",
    });
  }

  return files;
}
