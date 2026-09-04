"use client";

/**
 * Blog agent (v2) intake surfaces: the setup band, the client's own
 * configuration, and free-form feedback. Copy follows the input contract:
 * sentence case, each field says what we do with the answer, optional fields say
 * the product runs without them.
 *
 * WHAT IS DELIBERATELY NOT ASKED. The pillars, the cluster map, the voice card,
 * the compliance patterns and the keyword targets are all BUILT by setup from the
 * client's own documents. And the SUBJECTS are not asked either — this agent's
 * particular rule: the writer takes its subject from the newsletter's published
 * handoff, going deep on something the newsletter already found. A subject box
 * here would promise a lane the agent does not have.
 *
 * NO SEATS. The blog writes for the company, and its one scope choice (company
 * page or an executive's byline) is a setup config field derived from the
 * client's profile, not a per-person row.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardTitle, Input, Label, Textarea } from "@/components/ui";
import { SavedFormCard } from "@/components/saved-form-card";
import { JobStatusBadge } from "@/components/job-status";
import { formatDate, relativeTime } from "@/lib/utils";
import type { JobStatus } from "@/lib/types";
import { IntakeNoRuns } from "@/components/intake-no-runs";
import { clientArchiveLink, intakeAnchorId } from "@/lib/agent-intake-links";
import { intakeSave } from "@/lib/intake-save";
import { AutoRefresh } from "@/components/auto-refresh";
import { useSetupFireWindow } from "@/components/setup-fire-window";
import { CreditPriceNote } from "@/components/credit-price-note";
import { IntakeRunError } from "@/components/intake-run-error";
import { creditsLabel } from "@/lib/credits";
import {
  runBlogSetupAction,
  saveBlogCompanyIntakeAction,
} from "@/lib/actions/blog-agent-actions";

/* ── client-safe props (serialized server-side) ── */

export interface BlogIntakeView {
  internalDomains?: string[];
  toneNote?: string;
  audienceNote?: string;
  bannedTopics?: string[];
  cmsName?: string;
}

export interface BlogRunRowView {
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
 * Setup produces the post index the writer claims its number in at step 01, the
 * clusters file its subject claim is written to at step 05, and the voice card it
 * writes against. Until it has run there is nothing to write from, and both
 * submit cores refuse a writer run — so this is where the press that unblocks
 * them lives.
 */
function SetupBand({
  clientId,
  isSetUp,
  detailsOnFile,
  runInFlight,
  setupCost,
  viewerIsBilled,
}: {
  clientId: string;
  isSetUp: boolean;
  detailsOnFile: boolean;
  /**
   * Is a run of this family queued or working right now (server-answered, off
   * the unfiltered job scan)? While setup has not happened it can only be the
   * setup run — the submit core refuses a writer run without it — so inside
   * this branch it reads as "setup is running".
   */
  runInFlight: boolean;
  setupCost: number;
  viewerIsBilled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Not a plain boolean: a press that a FAILED run followed used to pin this
  // band for the rest of the session. See setup-fire-window.ts.
  const { fired, markFired } = useSetupFireWindow(runInFlight);

  function run() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() => runBlogSetupAction({ clientId }));
      if (result.error) {
        setError(result.error);
        return;
      }
      markFired();
      router.refresh();
    });
  }

  // FLOW AUDIT 2026-09, R1. `fired` alone was the whole of this state, so the
  // sentence below promised a refresh no interval ever performed AND vanished
  // on a reload — putting the "Set it up" button back on screen while the run
  // it fires was already in flight, one press away from a second charge. The
  // server's own in-flight answer holds both.
  const running = runInFlight || fired;

  if (isSetUp) {
    return (
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Your blog is set up</CardTitle>
          <Badge tone="success">Ready</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          The subjects you cover, how the writing sounds and the numbering are all in place. Every
          run reads them, and your answers below keep steering them.
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
        One run works out what your blog is: the groups of subjects worth owning, how the writing
        should sound, and the numbering every future article follows. It is all built from the
        material you already gave us and from any posts you have published, and nothing goes on your
        site. After this, every run prepares one article for you to publish.
      </p>
      {running ? (
        <>
          {/* The component that keeps the sentence. Mounted only while a run is
              in flight; the server rendering "set up" above unmounts it. */}
          <AutoRefresh />
          <p className="mt-3 text-sm text-muted">
            Setup is running. This page updates itself when it finishes.
          </p>
        </>
      ) : (
        <>
          {!detailsOnFile ? (
            <p className="mt-3 text-xs text-muted-2">
              Save your details below first, so setup knows your rules.
            </p>
          ) : null}
          <IntakeRunError error={error} />
          {/* R3: this press charges a full agent run and used to quote nothing. */}
          <CreditPriceNote price={creditsLabel(setupCost)} viewerIsBilled={viewerIsBilled} />
          <Button onClick={run} disabled={pending || !detailsOnFile} className="mt-3">
            {pending ? "Starting…" : "Set it up"}
          </Button>
        </>
      )}
    </Card>
  );
}

/* ─────────────────────── the details form ─────────────────────── */

function DetailsForm({ clientId, intake }: { clientId: string; intake: BlogIntakeView | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!intake);
  const [internalDomains, setInternalDomains] = useState((intake?.internalDomains ?? []).join("\n"));
  const [toneNote, setToneNote] = useState(intake?.toneNote ?? "");
  const [audienceNote, setAudienceNote] = useState(intake?.audienceNote ?? "");
  const [bannedTopics, setBannedTopics] = useState((intake?.bannedTopics ?? []).join("\n"));
  const [cmsName, setCmsName] = useState(intake?.cmsName ?? "");

  function save() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() =>
        saveBlogCompanyIntakeAction({
          clientId,
          internalDomains,
          toneNote,
          audienceNote,
          bannedTopics,
          cmsName,
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
    setInternalDomains((intake?.internalDomains ?? []).join("\n"));
    setToneNote(intake?.toneNote ?? "");
    setAudienceNote(intake?.audienceNote ?? "");
    setBannedTopics((intake?.bannedTopics ?? []).join("\n"));
    setCmsName(intake?.cmsName ?? "");
    setEditing(false);
  }

  return (
    <SavedFormCard
      title="Your blog details"
      badge={
        /* R7: "Not set up" is the setup band's phrase for "the stand-up run has
           not happened". This badge answers a different question — is the form
           saved — and one page must not spell two states the same way. */
        intake ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Not saved yet</Badge>
      }
      summary={[
        // Read off the SAVED view, not the live field, so the collapsed card
        // shows what the agent will actually run on rather than unsaved typing.
        { label: "Your own websites", value: (intake?.internalDomains ?? []).join(", ") },
        { label: "Who the articles are for", value: intake?.audienceNote ?? "" },
        { label: "Subjects we never write about", value: (intake?.bannedTopics ?? []).join(", ") },
        { label: "Where you publish", value: intake?.cmsName ?? "" },
      ]}
      open={editing}
      onEdit={() => setEditing(true)}
    >
      <p className="mt-1 text-sm text-muted">
        We prepare a full article, ready to publish, and you put it on your site. What each article
        is about comes from your newsletter: we take something it covered and go properly deep on
        it, so there is no subject list to keep here. This form only covers what we cannot work out.
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="bl-domains">Which websites are yours? (optional)</Label>
          <Textarea
            id="bl-domains"
            rows={3}
            value={internalDomains}
            onChange={(e) => setInternalDomains(e.target.value)}
            placeholder={"One per line.\nacme.com\nblog.acme.com"}
          />
          <p className="mt-1 text-xs text-muted">
            So we can link between your own pages. We only ever link to a page that exists. If an
            article wants a link you have not published yet, we note it and add it once you have.
          </p>
        </div>
        <div>
          <Label htmlFor="bl-audience">Who are these articles for? (optional)</Label>
          <Textarea
            id="bl-audience"
            rows={2}
            value={audienceNote}
            onChange={(e) => setAudienceNote(e.target.value)}
            placeholder="For example: heads of finance at mid-sized firms who are comparing us to a spreadsheet."
          />
          <p className="mt-1 text-xs text-muted">
            We work your audience out from your onboarding material. This is your chance to correct
            us if the person you picture is not the one we would have guessed.
          </p>
        </div>
        <div>
          <Label htmlFor="bl-tone">Anything wrong with how we write for you? (optional)</Label>
          <Textarea
            id="bl-tone"
            rows={2}
            value={toneNote}
            onChange={(e) => setToneNote(e.target.value)}
            placeholder="For example: we are more direct than this, and we never use questions as headings."
          />
          <p className="mt-1 text-xs text-muted">
            We build a picture of your voice from your own writing. Where this disagrees with it,
            this wins.
          </p>
        </div>
        <div>
          <Label htmlFor="bl-banned">Subjects we should never write about? (optional)</Label>
          <Textarea
            id="bl-banned"
            rows={3}
            value={bannedTopics}
            onChange={(e) => setBannedTopics(e.target.value)}
            placeholder={"One per line, or separated by commas.\ncompetitor comparisons\nongoing litigation"}
          />
          <p className="mt-1 text-xs text-muted">
            We check every article against this before it reaches you, and hold the whole piece
            rather than quietly writing around it. Our own house rules apply either way.
          </p>
        </div>
        <div>
          <Label htmlFor="bl-cms">Where do you publish your articles? (optional)</Label>
          <Input
            id="bl-cms"
            value={cmsName}
            onChange={(e) => setCmsName(e.target.value)}
            placeholder="WordPress, Webflow, your own site…"
          />
          <p className="mt-1 text-xs text-muted">
            Only so we know what to hand you. Every article comes with a version that pastes
            straight into your editor, plus the title, description and link details your platform
            asks for. You publish it; we never need access.
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

/* ─────────────────────────── feedback ─────────────────────────── */

function FeedbackBox({
  clientId,
  runs,
  isStaff,
}: {
  clientId: string;
  runs: BlogRunRowView[];
  isStaff: boolean;
}) {
  // #90: `?tab=archive` is read only by ProgressView, and a staff viewer at the
  // flat /tasks never gets one. The destination and its label move together.
  const archive = clientArchiveLink({ clientId, isStaff });

  return (
    <Card className="p-5">
      <CardTitle>Your articles</CardTitle>
      {/* NO FEEDBACK BOX HERE, unlike the other four surfaces, and the reason is
          a real product gap rather than an oversight worth hiding. The blog's
          own framework lists feedback capture — published / edited / skipped —
          on the portal's to-do list, and names its two readers: the writer's
          step 04 and the manager's step 02. Until those rows exist there is
          nothing for a note typed here to reach, and a box that quietly went
          nowhere would be worse than none. The archive is where a client's
          reaction is recorded today. */}
      <p className="mt-1 text-sm text-muted">
        Once your Karos team has approved an article, it appears in{" "}
        <a href={archive.href} className="underline hover:text-foreground">
          {archive.label}
        </a>{" "}
        with everything you need to publish it: the page, a version that pastes into your editor,
        and the title and description details your platform asks for.
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
      ) : (
        <IntakeNoRuns clientId={clientId} noun="articles" />
      )}
    </Card>
  );
}

/* ────────────────────────── the page body ───────────────────────── */

export function BlogAgentIntake({
  clientId,
  company,
  isSetUp,
  runs,
  runInFlight = false,
  setupCost,
  viewerIsBilled = true,
  isStaff,
}: {
  clientId: string;
  company: BlogIntakeView | null;
  /**
   * Has v2 setup produced a post index for this client? Answered from the same
   * row the submit core gates on, so the band and the server agree about what
   * "set up" means. Absent on props built before setup existed — treated as set
   * up, so an older caller never shows a client a step that is not theirs.
   */
  isSetUp?: boolean;
  runs: BlogRunRowView[];
  /**
   * Is a run of this family queued or working? Answered on the server from the
   * unfiltered job scan (`anyRunInFlight`), never from `runs` — those rows are
   * the collapsed DISPLAY list. Absent ⇒ false, so an older caller polls
   * nothing rather than polling forever.
   */
  runInFlight?: boolean;
  /** What one setup press costs a billable client, resolved off the agent doc. */
  setupCost: number;
  /** `isBillableClientActor()` — decides whose money the quote names, not the figure. */
  viewerIsBilled?: boolean;
  /** Whose vocabulary the run rows are written in — see FeedbackBox. */
  isStaff: boolean;
}) {
  return (
    <div className="space-y-6">
      <SetupBand
        clientId={clientId}
        isSetUp={isSetUp ?? true}
        detailsOnFile={company !== null}
        runInFlight={runInFlight}
        setupCost={setupCost}
        viewerIsBilled={viewerIsBilled}
      />
      {/* The anchor the agent page's inputs band links its one row to (#85).
          The blog has no seats and no news drop, so "company" is the whole set —
          and it is derived from the same row id the band mints, not spelled
          twice. */}
      <div id={intakeAnchorId("company")} className="scroll-mt-24">
        <DetailsForm clientId={clientId} intake={company} />
      </div>
      <FeedbackBox clientId={clientId} runs={runs} isStaff={isStaff} />
    </div>
  );
}
