"use client";

/**
 * Reputation agent (v2) intake surfaces: the setup band and the client's own
 * configuration. Copy follows the input contract: sentence case, each field says
 * what we do with the answer, optional fields say the product runs without them.
 *
 * WHAT IS DELIBERATELY NOT ASKED. The roster proper, the response voice, the
 * autonomy bounds and the recurring complaint themes are all BUILT by setup from
 * the client's own documents and their real review history.
 *
 * THE ONE FIELD THAT IS UNLIKE THE OTHER FOUR FAMILIES' is "who should hear
 * about it". This agent is draft-only, so when it finds something urgent the
 * portal's entire answer is telling a person, and that person exists in no
 * document we hold. It is the only field here whose absence has a same-day cost,
 * which is why it is the only one the form nudges about rather than shrugging at.
 *
 * NO SEATS. A review is about the business, not a person.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardTitle, Input, Label, Textarea } from "@/components/ui";
import { SavedFormCard } from "@/components/saved-form-card";
import { JobStatusBadge } from "@/components/job-status";
import { formatDate, relativeTime } from "@/lib/utils";
import type { JobStatus } from "@/lib/types";
import { clientArchiveLink, intakeAnchorId } from "@/lib/agent-intake-links";
import { intakeSave } from "@/lib/intake-save";
import {
  runReputationSetupAction,
  saveReputationCompanyIntakeAction,
} from "@/lib/actions/reputation-agent-actions";

/* ── client-safe props (serialized server-side) ── */

export interface ReputationIntakeView {
  reviewSurfaces?: string[];
  reviewMarkets?: string[];
  reputationContext?: string;
  crisisRoutingTag?: string;
  responseNoGos?: string[];
}

export interface ReputationRunRowView {
  id: string;
  /** Typed so the row renders through JobStatusBadge, never the raw word. */
  status: JobStatus;
  createdAt: number;
  href?: string;
}

function fieldError(error: string | null) {
  return error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null;
}

/* ─────────────────────── the setup band ─────────────────────── */

/**
 * The one-time stand-up, as a button and a status rather than a form.
 *
 * Setup produces the roster the runner reads from, the voice it writes in and
 * the bounds that decide what gets escalated. Until it has run there is nowhere
 * to read reviews from, and the submit core refuses a pulse, so this is where
 * the press that unblocks it lives.
 */
function SetupBand({
  clientId,
  isSetUp,
  detailsOnFile,
}: {
  clientId: string;
  isSetUp: boolean;
  detailsOnFile: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fired, setFired] = useState(false);

  function run() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() => runReputationSetupAction({ clientId }));
      if (result.error) {
        setError(result.error);
        return;
      }
      setFired(true);
      router.refresh();
    });
  }

  if (isSetUp) {
    return (
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Your review monitoring is set up</CardTitle>
          <Badge tone="success">Ready</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          We know which listings are yours, how a reply from you should sound, and what counts as
          urgent. Every check reads all three, and your answers below keep steering them.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>We need to set this up first</CardTitle>
        <Badge tone="warning">Not set up</Badge>
      </div>
      <p className="mt-1 text-sm text-muted">
        One run finds your real listings on each site, works out how a reply from you should sound,
        and sets what counts as urgent enough to put in front of a person. It is built from the
        material you already gave us and from the reviews you already have. Nothing is posted
        anywhere. After this, every check reads what is new and drafts replies for you to send.
      </p>
      {fired ? (
        <p className="mt-3 text-sm text-muted">
          Setup is running. This page updates itself when it finishes.
        </p>
      ) : (
        <>
          {!detailsOnFile ? (
            <p className="mt-3 text-xs text-muted-2">
              Save your details below first, so setup knows your rules.
            </p>
          ) : null}
          {fieldError(error)}
          <Button onClick={run} disabled={pending || !detailsOnFile} className="mt-3">
            {pending ? "Starting…" : "Set it up"}
          </Button>
        </>
      )}
    </Card>
  );
}

/* ─────────────────────── the details form ─────────────────────── */

function DetailsForm({
  clientId,
  intake,
}: {
  clientId: string;
  intake: ReputationIntakeView | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!intake);
  const [reviewSurfaces, setReviewSurfaces] = useState((intake?.reviewSurfaces ?? []).join("\n"));
  const [reviewMarkets, setReviewMarkets] = useState((intake?.reviewMarkets ?? []).join("\n"));
  const [reputationContext, setReputationContext] = useState(intake?.reputationContext ?? "");
  const [crisisRoutingTag, setCrisisRoutingTag] = useState(intake?.crisisRoutingTag ?? "");
  const [responseNoGos, setResponseNoGos] = useState((intake?.responseNoGos ?? []).join("\n"));

  function save() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() =>
        saveReputationCompanyIntakeAction({
          clientId,
          reviewSurfaces,
          reviewMarkets,
          reputationContext,
          crisisRoutingTag,
          responseNoGos,
        }),
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function cancel() {
    setError(null);
    setReviewSurfaces((intake?.reviewSurfaces ?? []).join("\n"));
    setReviewMarkets((intake?.reviewMarkets ?? []).join("\n"));
    setReputationContext(intake?.reputationContext ?? "");
    setCrisisRoutingTag(intake?.crisisRoutingTag ?? "");
    setResponseNoGos((intake?.responseNoGos ?? []).join("\n"));
    setEditing(false);
  }

  return (
    <SavedFormCard
      title="Your review details"
      badge={
        intake ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Not set up</Badge>
      }
      // The routing contact leads the summary rather than the sites, because it
      // is the one line whose absence costs something the same day.
      summary={[
        { label: "Who hears about an urgent review", value: intake?.crisisRoutingTag ?? "" },
        { label: "Where you are reviewed", value: (intake?.reviewSurfaces ?? []).join(", ") },
        { label: "Locations", value: (intake?.reviewMarkets ?? []).join(", ") },
        { label: "Never say in a reply", value: (intake?.responseNoGos ?? []).join(", ") },
      ]}
      open={editing}
      onEdit={() => setEditing(true)}
    >
      <p className="mt-1 text-sm text-muted">
        We read what people post about you and write replies for you to send. We never post
        anything, and we never answer the same review twice. Which listings are yours and how you
        should sound are worked out during setup; this form only covers what we cannot find out.
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="rp-crisis">Who should hear about an urgent review? (optional)</Label>
          <Input
            id="rp-crisis"
            value={crisisRoutingTag}
            onChange={(e) => setCrisisRoutingTag(e.target.value)}
            placeholder="A name, a shared inbox, or how to reach whoever is on call"
          />
          <p className="mt-1 text-xs text-muted">
            The one thing we cannot work out for ourselves. When something looks serious we flag it
            rather than reply, and this is who we name so it reaches the right person the same day.
            Leave it empty and we still flag it, but it waits until someone opens the report.
          </p>
        </div>
        <div>
          <Label htmlFor="rp-surfaces">Where do people review you? (optional)</Label>
          <Textarea
            id="rp-surfaces"
            rows={3}
            value={reviewSurfaces}
            onChange={(e) => setReviewSurfaces(e.target.value)}
            placeholder={"One per line.\nGoogle\nYelp\nTrustpilot"}
          />
          <p className="mt-1 text-xs text-muted">
            A starting point, not the final list. We confirm which listings are actually yours
            during setup, which matters more than it sounds: businesses often have listings they
            never made, under names they no longer use.
          </p>
        </div>
        <div>
          <Label htmlFor="rp-markets">Which locations or markets? (optional)</Label>
          <Textarea
            id="rp-markets"
            rows={2}
            value={reviewMarkets}
            onChange={(e) => setReviewMarkets(e.target.value)}
            placeholder="One per line. Leave empty if you are a single site."
          />
          <p className="mt-1 text-xs text-muted">
            So one branch&apos;s complaints stay out of another branch&apos;s report.
          </p>
        </div>
        <div>
          <Label htmlFor="rp-context">
            Anything going on we should know about? (optional)
          </Label>
          <Textarea
            id="rp-context"
            rows={2}
            value={reputationContext}
            onChange={(e) => setReputationContext(e.target.value)}
            placeholder="An outage, a recall, a change of ownership, a dispute in progress."
          />
          <p className="mt-1 text-xs text-muted">
            Background for whoever is writing, so a reply does not contradict something you are
            already dealing with. We never raise it in a reply unless the reviewer does.
          </p>
        </div>
        <div>
          <Label htmlFor="rp-nogos">Anything we must never say in a reply? (optional)</Label>
          <Textarea
            id="rp-nogos"
            rows={3}
            value={responseNoGos}
            onChange={(e) => setResponseNoGos(e.target.value)}
            placeholder={"One per line, or separated by commas.\npromise a refund\nadmit fault"}
          />
          <p className="mt-1 text-xs text-muted">
            We hold the whole reply rather than writing around one of these. A reply that dodges
            your own rule reads as evasive in public, which is worse than no reply. Our house rules
            apply either way.
          </p>
        </div>
        {fieldError(error)}
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save details"}
          </Button>
          {intake ? (
            <Button variant="ghost" onClick={cancel} disabled={pending}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </SavedFormCard>
  );
}

/* ─────────────────────────── run history ─────────────────────────── */

function HistoryBox({
  clientId,
  runs,
  isStaff,
}: {
  clientId: string;
  runs: ReputationRunRowView[];
  isStaff: boolean;
}) {
  // #90: `?tab=archive` is read only by ProgressView, and a staff viewer at the
  // flat /tasks never gets one. The destination and its label move together.
  const archive = clientArchiveLink({ clientId, isStaff });

  return (
    <Card className="p-5">
      <CardTitle>Your replies</CardTitle>
      {/* NO FEEDBACK BOX, for the same reason the blog surface has none: the
          feedback channel these agents read does not exist yet, and a box that
          quietly went nowhere is worse than none. What a human actually edited
          before sending is the manager's signal, and it comes off the archive. */}
      <p className="mt-1 text-sm text-muted">
        Once your Karos team has approved a reply, it appears in{" "}
        <a href={archive.href} className="underline hover:text-foreground">
          {archive.label}
        </a>{" "}
        ready to copy and post yourself. Anything we flagged as urgent is at the top of the report,
        not in the replies.
      </p>
      {runs.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {runs.slice(0, 4).map((r) => {
            /* C2 (parity pass 2026-09). The CLIENT'S sentence is the primary
               text for BOTH roles. Staff used to read `Run <date>` in its
               place, so one row said two different things and a staff preview
               of this page could not be compared with what the client gets.
               They lose nothing: the exact generation instant they debug with
               is appended as a muted secondary suffix, and the /jobs link -
               staff-only, staff-guarded, and outside the client workspace -
               rides on that suffix behind an Internal marker. The per-day
               collapse for clients still happens server-side (toRunRowViews). */
            const label = `Worked on your content · ${relativeTime(r.createdAt)}`;
            const stamp = `Run ${formatDate(r.createdAt)}`;
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{label}</span>
                {isStaff &&
                  (r.href ? (
                    <a href={r.href} className="text-muted-2 underline hover:text-foreground">
                      {stamp}
                    </a>
                  ) : (
                    <span className="text-muted-2">{stamp}</span>
                  ))}
                {isStaff && r.href && <Badge tone="neutral">Internal</Badge>}
                <JobStatusBadge status={r.status} />
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}

/* ────────────────────────── the page body ───────────────────────── */

export function ReputationAgentIntake({
  clientId,
  company,
  isSetUp,
  runs,
  isStaff,
}: {
  clientId: string;
  company: ReputationIntakeView | null;
  /**
   * Has setup produced a roster for this client? Answered from the same row the
   * submit core gates on, so the band and the server agree about what "set up"
   * means. Absent on props built before setup existed — treated as set up, so an
   * older caller never shows a client a step that is not theirs.
   */
  isSetUp?: boolean;
  runs: ReputationRunRowView[];
  /** Whose vocabulary the run rows are written in — see HistoryBox. */
  isStaff: boolean;
}) {
  return (
    <div className="space-y-6">
      <SetupBand clientId={clientId} isSetUp={isSetUp ?? true} detailsOnFile={company !== null} />
      {/* The anchor the agent page's inputs band links its one row to (#85).
          Reputation has no seats and no news drop, so "company" is the whole
          set, derived from the same row id the band mints rather than spelled
          twice. */}
      <div id={intakeAnchorId("company")} className="scroll-mt-24">
        <DetailsForm clientId={clientId} intake={company} />
      </div>
      <HistoryBox clientId={clientId} runs={runs} isStaff={isStaff} />
    </div>
  );
}
