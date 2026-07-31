/**
 * Activity-log titles that narrate the MACHINE rather than the work.
 *
 * Pure and client-safe (no server-only imports), like activity-actors.ts beside
 * it, so the writers that mint these titles and the projection that hides them
 * read the same strings.
 *
 * An ActivityLog's `title` is stored verbatim and reaches a client's Activity
 * tab verbatim — tasks-body.tsx projects the row field by field but passes
 * `log.title` through, and nothing on the read path filters by type. So
 * "Managed job started: Social posts (IG/TikTok)" — written for the operator
 * who needs to know a submission left the building — was being read by the
 * client as an announcement that a machine had begun a job.
 *
 * That is the A3/A4 rule twice over:
 *
 *  1. Vocabulary. "job", "run", "setup", "started" are the machinery a client's
 *     surfaces do not narrate. Their timeline says what was worked on, not what
 *     was dispatched.
 *  2. Shape. These rows are minted one per dispatch, so a runway sweep that
 *     tops a client up writes up to fourteen of them inside the same minute
 *     (RUNWAY_MAX_JOBS_PER_CLIENT, default 14). Fourteen identically-stamped
 *     lines IS the batch tell — the same defect the timeline's own run
 *     aggregation was added to close.
 *
 * A client is not left with a gap. Every writer below mints a JOB alongside its
 * row, and the timeline already narrates jobs for a client — collapsed to one
 * row per agent per day, in outcome language ("<agent> worked on your
 * content"). The machinery row is a second, worse telling of an event that is
 * already on the screen. The one exception is the launch/setup run, whose
 * client-facing story is the launch card's three phases and whose job row is
 * deliberately dropped from a client's timeline for exactly that reason
 * (tasks-body.tsx filters `runType !== "launch"`); a machinery row that
 * re-announced it would restore the double identity that filter removed.
 *
 * Staff keep the full truth: the row is unchanged on disk and unchanged in a
 * staff viewer's timeline.
 */

/** `submitManagedJob` — a catalog product dispatched to the agent service. */
export function managedRunStartedTitle(productLabel: string): string {
  return `Managed job started: ${productLabel}`;
}

/** `submitCustomJob` / `runCustomAgent` — a custom (lab-repo) agent dispatch. */
export function customRunStartedTitle(agentName: string): string {
  return `Agent run started: ${agentName}`;
}

/** A manual template run fired from a client agent's umbrella. */
export function templateRunStartedTitle(umbrellaName: string, templateName: string): string {
  return `${umbrellaName}: ${templateName} run started`;
}

/** The launch/setup run that stands a client agent up. */
export function agentSetupStartedTitle(umbrellaName: string): string {
  return `Agent setup started: ${umbrellaName}`;
}

/** `importLabRunAction` — a lab run's deliverables copied into the portal. */
export function labImportTitle(runKey: string, created: number): string {
  return `Imported lab run: ${runKey} (${created} item${created !== 1 ? "s" : ""})`;
}

/**
 * The Ops Import surface — staff pulled locally-produced updates in. The
 * detail suffix varies per import; the prefix is the contract the pattern
 * below matches on.
 */
export function opsImportTitle(sourceLabel: string, detail: string): string {
  return `Ops import from ${sourceLabel}: ${detail}`;
}

/**
 * The staff "Import Intelligence Report" surface, RETIRED 2026-07-31 — the
 * modal was mounted nowhere and its action went with it (QA #99).
 *
 * No writer remains, so this builder names a string that only STORED rows
 * carry. It is kept for exactly one reason: the pattern below has to keep
 * redacting those rows from client timelines, and the guard test needs the
 * literal to assert that against. Do not read it as a live writer.
 */
export function intelReportImportedTitle(): string {
  return "Intel Report imported";
}

/**
 * The shapes above, matched on the STORED string.
 *
 * Patterns rather than an exact set, because the rows this has to catch are
 * already in Firestore: production carries months of them, minted before the
 * builders existed, and a client reading their timeline today reads those. The
 * builders keep new writers from drifting away from the patterns (there is a
 * guard test that pins every writer to a builder); the patterns keep the fix
 * retroactive.
 */
const RUN_MACHINERY_PATTERNS: readonly RegExp[] = [
  /^managed job started: /i,
  /^agent run started: /i,
  /^agent setup started: /i,
  / run started$/i,
  // Data-ops machinery (pass-3 follow-up): lab run keys, repo refs and write
  // counts are operator bookkeeping. The work these imports produce reaches
  // the client as documents and drafts with their own honest rows.
  /^imported lab run: /i,
  /^ops import from /i,
  // The retired staff intel-report import (QA #99). Retroactive only: nothing
  // writes this row any more, and the stored ones stay redacted. The derived
  // "Research report ready" row (activity-timeline's hasIntelLog dedupe) is the
  // honest client-facing telling and renders in its place.
  /^intel report imported$/i,
  // Retroactive only: the old schedule-change wording decomposed the batch
  // ("3 runs per week (12 drafts)"). New rows mint in pace vocabulary and
  // stay on the client's timeline.
  / runs? per week \(\d+ drafts?\)$/i,
];

/**
 * Does this row announce machinery starting rather than work happening?
 *
 * Deliberately narrow: it matches "a run/job/setup began" and data-ops
 * bookkeeping, not everything an automated writer produces. A failed
 * generation cycle, a competitor analysis, a brand-guideline rewrite and a
 * schedule change are all things that HAPPENED to the client's account, and
 * they stay on the client's timeline.
 */
export function isRunMachineryTitle(title: string): boolean {
  const t = title.trim();
  return RUN_MACHINERY_PATTERNS.some((re) => re.test(t));
}
