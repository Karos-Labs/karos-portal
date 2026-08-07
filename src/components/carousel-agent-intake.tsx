"use client";

/**
 * Carousel agent (v2) intake surfaces: the setup band and the client's own
 * configuration. Copy follows the input contract: sentence case, each field says
 * what we do with the answer, optional fields say the product runs without them.
 *
 * WHAT IS DELIBERATELY NOT ASKED. The visual style, the brand tokens, the slide
 * templates and the topic catalogue are all BUILT by setup from the client's own
 * brand material. A colour picker here would put a second author on the one file
 * whose whole job is that every slide matches every other slide.
 *
 * NO SEATS. A carousel is posted from the company account.
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
  runCarouselSetupAction,
  saveCarouselCompanyIntakeAction,
} from "@/lib/actions/carousel-agent-actions";

/* ── client-safe props (serialized server-side) ── */

export interface CarouselIntakeView {
  carouselHandle?: string;
  /** Null and undefined both mean "let the agent decide", which is the default. */
  slideCountPreference?: number | null;
  bannedTopics?: string[];
}

export interface CarouselRunRowView {
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
 * Setup produces the visual system every slide obeys, the templates that render
 * them and the topic catalogue every post draws from. Until it has run there is
 * no style to build against, and the submit core refuses a run, so this is where
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
      const result = await intakeSave(() => runCarouselSetupAction({ clientId }));
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
          <CardTitle>Your carousels are set up</CardTitle>
          <Badge tone="success">Ready</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          The look, the slide layouts and the list of subjects to work through are all in place.
          Every post reads them, and your answers below keep steering them.
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
        One run works out how your slides should look, builds the layouts they are made from, and
        writes the list of subjects worth covering. It is all built from the brand material you
        already gave us, and nothing is posted. After this, every run makes one carousel for you to
        review.
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

function DetailsForm({ clientId, intake }: { clientId: string; intake: CarouselIntakeView | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!intake);
  const [carouselHandle, setCarouselHandle] = useState(intake?.carouselHandle ?? "");
  const [slideCount, setSlideCount] = useState(
    intake?.slideCountPreference == null ? "" : String(intake.slideCountPreference),
  );
  const [bannedTopics, setBannedTopics] = useState((intake?.bannedTopics ?? []).join("\n"));

  function save() {
    setError(null);
    start(async () => {
      const result = await intakeSave(() =>
        saveCarouselCompanyIntakeAction({
          clientId,
          carouselHandle,
          slideCount,
          bannedTopics,
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
    setCarouselHandle(intake?.carouselHandle ?? "");
    setSlideCount(intake?.slideCountPreference == null ? "" : String(intake.slideCountPreference));
    setBannedTopics((intake?.bannedTopics ?? []).join("\n"));
    setEditing(false);
  }

  return (
    <SavedFormCard
      title="Your carousel details"
      badge={
        intake ? <Badge tone="success">On file</Badge> : <Badge tone="warning">Not set up</Badge>
      }
      summary={[
        // Read off the SAVED view, not the live field, so the collapsed card
        // shows what the agent will actually run on rather than unsaved typing.
        { label: "Account these are for", value: intake?.carouselHandle ?? "" },
        {
          label: "Slides per post",
          // "We choose per topic" rather than an empty cell: not setting one is
          // the product default and the better answer, so it reads as a decision.
          value:
            intake?.slideCountPreference == null
              ? intake
                ? "We choose per topic"
                : ""
              : String(intake.slideCountPreference),
        },
        { label: "Never build one about", value: (intake?.bannedTopics ?? []).join(", ") },
      ]}
      open={editing}
      onEdit={() => setEditing(true)}
    >
      <p className="mt-1 text-sm text-muted">
        We build a full carousel, slides and caption, ready for you to post. How it looks and which
        subjects it works through are set up once from your brand material, so there is no design
        work here. This form only covers what we cannot work out.
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="cr-handle">Which account are these for? (optional)</Label>
          <Input
            id="cr-handle"
            value={carouselHandle}
            onChange={(e) => setCarouselHandle(e.target.value)}
            placeholder="@yourhandle"
          />
          <p className="mt-1 text-xs text-muted">
            Only so we can label the drafts and sign a caption off the right way. We never connect
            to it and we never post: the slides come to you as images to upload.
          </p>
        </div>
        <div>
          <Label htmlFor="cr-slides">How many slides per post? (optional)</Label>
          <Input
            id="cr-slides"
            value={slideCount}
            onChange={(e) => setSlideCount(e.target.value)}
            placeholder="Leave empty and we choose per subject"
          />
          <p className="mt-1 text-xs text-muted">
            Leaving it empty is usually better: some subjects need six slides and some need ten, and
            padding to a fixed number is the fastest way to make a carousel boring.
          </p>
        </div>
        <div>
          <Label htmlFor="cr-banned">Subjects we should never build one about? (optional)</Label>
          <Textarea
            id="cr-banned"
            rows={3}
            value={bannedTopics}
            onChange={(e) => setBannedTopics(e.target.value)}
            placeholder={"One per line, or separated by commas.\ncompetitor comparisons\npricing"}
          />
          <p className="mt-1 text-xs text-muted">
            We check every subject against this, including ones already on your list. Our own house
            rules apply either way.
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
  runs: CarouselRunRowView[];
  isStaff: boolean;
}) {
  // #90: `?tab=archive` is read only by ProgressView, and a staff viewer at the
  // flat /tasks never gets one. The destination and its label move together.
  const archive = clientArchiveLink({ clientId, isStaff });

  return (
    <Card className="p-5">
      <CardTitle>Your carousels</CardTitle>
      <p className="mt-1 text-sm text-muted">
        Once your Karos team has approved a carousel, it appears in{" "}
        <a href={archive.href} className="underline hover:text-foreground">
          {archive.label}
        </a>{" "}
        with every slide as an image and the caption ready to copy.
      </p>
      {runs.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {runs.slice(0, 4).map((r) => {
            // A3/A4: staff keep the machinery noun and the exact instant, which
            // is what they debug with; a client gets the relative language every
            // other client-facing stamp uses.
            const label = isStaff
              ? `Run ${formatDate(r.createdAt)}`
              : `Worked on your content · ${relativeTime(r.createdAt)}`;
            return (
              <li key={r.id} className="flex items-center gap-2 text-xs text-muted">
                {r.href ? (
                  <a href={r.href} className="underline hover:text-foreground">
                    {label}
                  </a>
                ) : (
                  <span>{label}</span>
                )}
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

export function CarouselAgentIntake({
  clientId,
  company,
  isSetUp,
  runs,
  isStaff,
}: {
  clientId: string;
  company: CarouselIntakeView | null;
  /**
   * Has setup produced a style config for this client? Answered from the same
   * row the submit core gates on, so the band and the server agree about what
   * "set up" means. Absent on props built before setup existed — treated as set
   * up, so an older caller never shows a client a step that is not theirs.
   */
  isSetUp?: boolean;
  runs: CarouselRunRowView[];
  /** Whose vocabulary the run rows are written in — see HistoryBox. */
  isStaff: boolean;
}) {
  return (
    <div className="space-y-6">
      <SetupBand clientId={clientId} isSetUp={isSetUp ?? true} detailsOnFile={company !== null} />
      {/* The anchor the agent page's inputs band links its one row to (#85).
          The carousel has no seats and no news drop, so "company" is the whole
          set, derived from the same row id the band mints rather than spelled
          twice. */}
      <div id={intakeAnchorId("company")} className="scroll-mt-24">
        <DetailsForm clientId={clientId} intake={company} />
      </div>
      <HistoryBox clientId={clientId} runs={runs} isStaff={isStaff} />
    </div>
  );
}
