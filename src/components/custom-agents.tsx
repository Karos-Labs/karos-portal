"use client";

import { type ComponentProps, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon, LinkedInLogo, XLogo } from "@/components/icon";
import {
  AgentIdentity,
  AgentMark,
  AgentPlatformBadges,
  SocialPlatformMark,
} from "@/components/agent-identity";
import { AgentInputFiles } from "@/components/agent-input-files";
import { BlogAgentIntake } from "@/components/blog-agent-intake";
import { CarouselAgentIntake } from "@/components/carousel-agent-intake";
import { ReputationAgentIntake } from "@/components/reputation-agent-intake";
import { LinkedInAgentIntake } from "@/components/linkedin-agent-intake";
import { NewsletterAgentIntake } from "@/components/newsletter-agent-intake";
import { RedditAgentIntake } from "@/components/reddit-agent-intake";
import { XAgentIntake } from "@/components/x-agent-intake";
import { Modal } from "@/components/modal";
import { ContactUsButton } from "@/components/contact-us-modal";
import { JobStatusBadge } from "@/components/job-status";
import { ManagedJobProgress } from "@/components/managed-job-progress";
import {
  createCustomAgentAction,
  deleteCustomAgentAction,
  runCustomAgentAction,
  runCustomAgentTestAction,
  setClientCustomAgentsAction,
  setCustomAgentEnabledAction,
  updateCustomAgentAction,
} from "@/lib/actions";
import {
  configureClientAgentScheduleAction,
  deletePlannedRunAction,
  setPlannedRunStatusAction,
} from "@/lib/actions/planned-run-actions";
import {
  cancelClientAgentJobAction,
  refreshJobStatusAction,
  retryJobAction,
} from "@/lib/actions/external-job-actions";
import {
  CREDIT_BLOCK_REASON,
  CREDIT_COSTS,
  creditsLabel,
  scheduledAgentWeeklyCost,
} from "@/lib/credits";
import { clientAgentBlurb } from "@/lib/agent-blurbs";
import { scheduleLimitsFor } from "@/lib/scheduled-runs";
import { validateScheduleTiming } from "@/lib/scheduling";
import { classifyJobError } from "@/lib/job-error-taxonomy";
import {
  agentKeyMatchesClientSlug,
  batchSizeFrom,
  buildCustomAgentPrompt,
  defaultRunBatchSize,
  initialAgentBrief,
  isLinkedInAgentIdentity,
  isXAgentIdentity,
  launchProfileFor,
  perClientAgentSlug,
  withLinkedInIdentityOptions,
  ADD_SEAT_OPTION_VALUE,
  LINKEDIN_IDENTITY_FIELD_KEY,
  BLOG_SETUP_REQUIRED_PREFIX,
  CAROUSEL_SETUP_REQUIRED_PREFIX,
  LINKEDIN_SETUP_REQUIRED_PREFIX,
  NEWSLETTER_SETUP_REQUIRED_PREFIX,
  REDDIT_SETUP_REQUIRED_PREFIX,
  REPUTATION_SETUP_REQUIRED_PREFIX,
  X_SETUP_REQUIRED_PREFIX,
  groupAgentsByParent,
  isSupersededAgentKey,
} from "@/lib/custom-agent-launch";
import type { ContextItem, CustomAgent, JobRunType, JobStatus } from "@/lib/types";
import { cn, formatDate, relativeTime } from "@/lib/utils";

/* ═══════════════════════ shared bits ═══════════════════════ */

/**
 * The slice of a CustomAgent that may be serialized to client-user browsers.
 * Deliberately excludes instructions (the system prompt), skill paths, and
 * repo provenance - pages map full docs down to this before passing them.
 *
 * `description` is NOT on it (F127). It is the lab repo's own skill manifest,
 * no surface that receives this summary reads it, and this module's whole
 * doctrine is that a field which crosses the boundary is readable from
 * view-source whether or not anything paints it. The staff agent LIBRARY still
 * shows it - that surface takes the full CustomAgent, which is the honest place
 * for manifest text to live.
 */
export type RunnableAgentSummary = Pick<
  CustomAgent,
  "id" | "key" | "name" | "clientBlurb" | "icon" | "color" | "enabled"
> & {
  creditCost?: number | null;
};

/**
 * What a client is allowed to read about an agent: the curated `clientBlurb`,
 * then the keyed fallback.
 *
 * Agents imported before that field existed used to fall back to the manifest
 * `description`. That is the defect Albert screenshotted (CD-G2): cards on his
 * own client pages reading "Master content-social skill. Given a brand's
 * guidelines + any past competitor research…". The fallback is now the keyed
 * blurb map, which always has a sentence written for a buyer - so the manifest
 * is no longer in the chain at all, nor in the payload, and the staff library
 * still flags agents with no curated blurb for a rewrite.
 */
function agentBlurb(agent: Pick<RunnableAgentSummary, "key" | "name" | "clientBlurb">): string {
  return clientAgentBlurb({
    key: agent.key,
    name: agent.name,
    clientBlurb: agent.clientBlurb ?? null,
  });
}

/** One run-history row, pre-filtered and stripped server-side. */
export interface CustomAgentRunRow {
  id: string;
  /** The run's STORED agent name. A join key - the card matches its own runs on it. */
  agentName: string;
  /**
   * The ONE name this row prints, resolved server-side through the §7.3
   * identity helper (F147). Equal to `agentName` for an agent with no
   * umbrella; the umbrella's own display name when one owns this stream.
   */
  label: string;
  status: JobStatus;
  createdAt: number;
  assetCount: number;
  /**
   * The operator's raw request. STAFF VIEWERS ONLY - a client's permanent run
   * history must not be somebody's typing, misspellings and all, so the page
   * omits it from the client payload rather than hiding it at render.
   */
  prompt?: string;
  /** Link target (staff viewers get /jobs/<id>); absent for client viewers. */
  href?: string;
  /**
   * Raw failure text (STAFF VIEWERS ONLY, same reasoning as `prompt`) - the
   * Control Room's Runs & Telemetry tab runs this through `classifyJobError`
   * for a human-readable label, keeping the raw string alongside it.
   */
  error?: string;
  /** How the run was initiated - staff-only, so a Test Run can badge itself distinctly. */
  runType?: JobRunType;
}

/** Client-safe recurring schedule fields shown on an activated agent card. */
export interface ClientAgentScheduleRow {
  id: string;
  agentId: string;
  status: "active" | "paused";
  postsPerWeek: number;
  outputsPerRun: number;
  nextRunAt: number;
  /**
   * The ongoing direction handed to the agent on every fire - STAFF-AUTHORED,
   * and absent for client viewers (toScheduleRows omits it). It used to ship
   * unconditionally and be painted in an editable textarea inside the client's
   * pace dialog, which both showed a client internal operator copy and let them
   * rewrite the instruction every future run receives.
   */
  prompt?: string;
  hour: number;
  minute: number;
  /**
   * The scheduler's refusal from the last fire that produced nothing. When set,
   * the card drops the "Live" badge - an always-on agent that is refused on
   * every fire must never read as healthy.
   */
  lastError?: string | null;
  /** Epoch millis of that refusal. */
  lastErrorAt?: number | null;
}

/**
 * The intake page an agent refuses to run without, by agent key - or null for
 * agents with no such gate. Used on the STAFF hub, where the client is chosen
 * inside the run dialog and per-agent readiness therefore cannot be resolved
 * before the card is drawn (the client page passes a resolved `agentSetup` map
 * instead). Names the gate; does not claim to know whether it is satisfied.
 */
function intakeDrivenLabel(key: string): string | null {
  if (isXAgentIdentity(key)) return "X agent data";
  if (isLinkedInAgentIdentity(key)) return "LinkedIn agent data";
  return null;
}

/** The dialog's dropdowns, built from the same bounds the server clamps to. */
/**
 * The dropdown ranges, read from the SAME per-agent limits the server clamps
 * with (scheduleLimitsFor). The Reddit agent's ceiling is lower than the
 * generic one (F27), and a dialog offering more than the server will accept
 * either silently rewrites the client's choice on save or bills for a pace the
 * product does not sell.
 */
function countOptions(max: number): number[] {
  return Array.from({ length: max }, (_, i) => i + 1);
}

function agentRunCost(agent: Pick<RunnableAgentSummary, "creditCost">): number {
  return agent.creditCost ?? CREDIT_COSTS.customAgentRun;
}

/**
 * The one-off SETUP price, or null when nobody has set one (§6.3).
 *
 * STAFF ONLY — it is deliberately absent from RunnableAgentSummary, so this
 * takes the full document and no client payload can carry it.
 *
 * "Is the field filled in" is the whole test here, and it is complete for
 * anything this app stored: every write of launchCreditCost goes through
 * `validateAgentInput` (lib/actions/custom-agent-actions.ts), which refuses
 * anything that is not a whole number greater than zero, and the repo import
 * never sets it at all. `evaluateLaunchGate` additionally rejects zero,
 * negatives and non-integers — that is its defence against rows this app did
 * not write, not a second rule this card has to keep in step with.
 */
function agentLaunchCost(agent: Pick<CustomAgent, "launchCreditCost">): number | null {
  return agent.launchCreditCost ?? null;
}

/**
 * An agent's blurb wherever a client reads it. Clamped to three lines so the
 * cut always lands on a line boundary - never mid-word - with a "More" control
 * that expands it in place. Whether the text overflows is MEASURED rather than
 * guessed from a character count: a length threshold is the same class of bug,
 * and the same prose wraps to a different number of lines per card width.
 */
function AgentBlurb({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = ref.current;
    // While expanded there is nothing to measure (the clamp is off) - keep the
    // last answer so the control that opened it does not vanish under the cursor.
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight - el.clientHeight > 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, expanded]);

  return (
    <div className={className}>
      <p ref={ref} className={cn("text-xs leading-relaxed text-muted", !expanded && "line-clamp-3")}>
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="mt-0.5 text-[11px] text-muted-2 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
        >
          {expanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

/**
 * The intake page an agent drafts from, when it has one (X e13, LinkedIn e10).
 *
 * Readiness is resolved PER AGENT on the server and handed down keyed by agent
 * id. It cannot be recomputed here from one shared flag: `hasLinkedInAgentIntake`
 * answers differently depending on the agent key it is given (the multi-seat
 * agent accepts any stored intake; the company-page agents require the company
 * form), and the submit core passes that key. A single shared answer would block
 * an agent the server would happily run.
 */
/**
 * One agent's intake state, resolved server-side.
 *
 * It carries BOTH routes to the same form, because the two surfaces that need
 * it can reach it differently. `href` is the agent's own data page and always
 * exists - that is what the client's detail route offers (CD-E1/CD-G1), and it
 * is the only option when the page did not prefetch the form. `kind`/`data`
 * appear when it DID: the run dialog then collects the intake in place, so a
 * staff member setting up a run does not lose the brief they were writing to a
 * navigation.
 *
 * kind and data move together - a kind with no payload would render an empty
 * pane, and a payload with no kind has no form to render it in.
 *
 * WHAT A CALLER OWES RunCustomAgentModal (#113). That dialog collects the intake
 * IN PLACE when it is handed a `kind`, and cannot when it is not: without the
 * payload it cannot tell which of the three agents it is looking at, so all it
 * can offer is `label` and `href` — the name of the form and the way to it. A
 * surface that mounts the run dialog for a state with `ready: false` and NO
 * `kind` should therefore refuse before opening it, which is what all three
 * mounts do today (the library disables Run, StaffAgentControls paints "Run now
 * needs the {label}" beside the agent's own href, and LegacyAgentPanel disables
 * the run on `evaluateLegacyRunGate`'s `setup_missing` rung and links the form).
 * That is why the dialog's own href gate is a backstop rather than a route.
 */
export type AgentSetupState = {
  ready: boolean;
  /**
   * Has this agent's one-time STAND-UP run happened? A second question from
   * `ready` ("has the client filled the form in"), and only LinkedIn v2 has it:
   * v2 derives the lanes, the voice and the first topics from a run, so a client
   * whose form is saved still has nothing to draft from until that run has been.
   *
   * TRUE for every other family, because they have no such run — answering "no"
   * for them would block agents the server would happily run.
   *
   * WHY IT IS A FIELD HERE rather than derived where it is needed. The predicate
   * already existed as `standUpDone()` below, but it reads `setup.data.isSetUp`,
   * which is only present when the intake PANES were built — and the client's
   * detail route builds panes for staff only. So for every client the old
   * predicate answered "done" by omission, which is the one answer that cannot be
   * right for the state both submit cores refuse on.
   *
   * IT MARKS AN OUTSTANDING STEP, not the raw predicate. Newsletter and blog v2
   * have stand-up runs too, and they answer the question a different way — both
   * fold `isSetUp` straight into `ready`, deliberately, because their writers
   * claim an index number at step 01 and a run started without one is charged for
   * and dies immediately. For them this field is `true`: their intake rung has
   * already refused, and reporting the raw flag would fire the stand-up rung a
   * second time and tell a newsletter client about LinkedIn.
   *
   * So two idioms coexist, which is worth naming rather than hiding: LinkedIn
   * keeps the questions separate so its copy can say "one press stands this up"
   * instead of blaming the client for answers they have already given, and the
   * other two merge them because the cheaper failure is to refuse early. Folding
   * all three onto this field is a real follow-up, and it needs the refusal
   * sentence to move onto the setup state per family first — the string in
   * client-agent-runs.ts names LinkedIn out loud.
   *
   * SCOPE, stated precisely because the two are easy to conflate: this field
   * reaches the surfaces that read an `AgentSetupState` directly — the two run
   * gates in client-agent-runs.ts. It does NOT reach the run dialog's
   * `standUpDone()` helper below, because `intakeFor` projects only
   * `{ ready, data }` into AgentIntakeContext, so that helper still derives the
   * answer from `data.isSetUp`. The two cannot disagree today — `isSetUp` is
   * `hasLinkedInV2Setup` too, resolved in agent-intake-views.ts — so this is
   * redundancy rather than drift, and collapsing them into one answer is a
   * follow-up that touches the dialog's open-on-data behaviour.
   */
  standUpDone: boolean;
  href: string;
  /**
   * The OPERATOR's name for the intake page, e.g. "X agent data" - it matches
   * the route, the manifest and how staff talk about it, and staff surfaces
   * (the run dialog, the roster note, StaffAgentControls) keep using it.
   */
  label: string;
  /**
   * The same page in a client's words, e.g. "Your X details".
   *
   * "Agent data" is our vocabulary, not theirs: a client reading "Manage X
   * agent data" beside "Reddit agent data - NEEDED" is being asked to maintain
   * a system's records rather than to tell us about themselves. Every
   * client-facing surface - the inputs band, the sidebar card, the run gates'
   * refusal lines - reads this one, so the three agents also stop each
   * inventing their own phrasing.
   */
  clientLabel: string;
} & (
  | { kind?: undefined; data?: undefined }
  | { kind: "x"; data: ComponentProps<typeof XAgentIntake> }
  | { kind: "linkedin"; data: ComponentProps<typeof LinkedInAgentIntake> }
  | { kind: "reddit"; data: ComponentProps<typeof RedditAgentIntake> }
  | { kind: "newsletter"; data: ComponentProps<typeof NewsletterAgentIntake> }
  | { kind: "blog"; data: ComponentProps<typeof BlogAgentIntake> }
  | { kind: "reputation"; data: ComponentProps<typeof ReputationAgentIntake> }
  | { kind: "carousel"; data: ComponentProps<typeof CarouselAgentIntake> }
);

function AgentChip({ agent, className }: { agent: Pick<RunnableAgentSummary, "key" | "name" | "icon">; className?: string }) {
  return (
    <AgentIdentity
      identity={`${agent.key} ${agent.name}`}
      icon={agent.icon}
      className={className}
    />
  );
}

/* ═══════ intake-driven agents (X e13, LinkedIn e10, Reddit e15) ═══════ */

/**
 * The X, LinkedIn and Reddit agents draft from stored intake, so their data
 * forms live inside the run dialog: inline on a first run, behind the
 * "<platform> agent data" button once the data exists. `ready` is the server run
 * gate; `data` is the payload rendered inline.
 */
export interface XAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof XAgentIntake>;
}

/** The e10 twin of XAgentSetup. */
export interface LinkedInAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof LinkedInAgentIntake>;
}

/** The e15 twin of XAgentSetup. */
export interface RedditAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof RedditAgentIntake>;
}

/** The newsletter v2 twin of XAgentSetup. */
export interface NewsletterAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof NewsletterAgentIntake>;
}

/** The blog v2 twin of XAgentSetup. */
export interface BlogAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof BlogAgentIntake>;
}

/** The reputation v2 twin of XAgentSetup. */
export interface ReputationAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof ReputationAgentIntake>;
}

/** The carousel v2 twin of XAgentSetup. */
export interface CarouselAgentSetup {
  ready: boolean;
  data: ComponentProps<typeof CarouselAgentIntake>;
}

type IntakeKind =
  | "x"
  | "linkedin"
  | "reddit"
  | "newsletter"
  | "blog"
  | "reputation"
  | "carousel";

type AgentIntakeContext =
  | { kind: "x"; setup: XAgentSetup }
  | { kind: "linkedin"; setup: LinkedInAgentSetup }
  | { kind: "reddit"; setup: RedditAgentSetup }
  | { kind: "newsletter"; setup: NewsletterAgentSetup }
  | { kind: "blog"; setup: BlogAgentSetup }
  | { kind: "reputation"; setup: ReputationAgentSetup }
  | { kind: "carousel"; setup: CarouselAgentSetup };

const INTAKE_LABEL: Record<IntakeKind, string> = {
  x: "X",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  newsletter: "Newsletter",
  blog: "Blog",
  reputation: "Reputation",
  carousel: "Carousel",
};

/** Route segment of the full agent data page, for callers with no inline payload. */
const INTAKE_ROUTE: Record<IntakeKind, string> = {
  x: "x-agent",
  linkedin: "linkedin-agent",
  reddit: "reddit-agent",
  newsletter: "newsletter-agent",
  blog: "blog-agent",
  reputation: "reputation-agent",
  carousel: "carousel-agent",
};

/**
 * What the agent drafts from, in the client's words - the run dialog says this
 * when the data is still missing. Per kind, because the four agents hold
 * genuinely different data: X and LinkedIn have a company page and seats,
 * Reddit has one account plus the subreddits it may answer in, and the
 * newsletter has neither an account nor a person - only how the client wants
 * their issue prepared.
 */
const INTAKE_ASKS: Record<IntakeKind, string> = {
  x: "the company page, a seat for each person, and your ongoing drops",
  linkedin: "the company page, a seat for each person, and your ongoing drops",
  reddit: "the account we draft as, and how you want mentions handled",
  newsletter: "the day you want your issue, and anything we must never print",
  // NOT a subject list, and the omission is the product: the blog takes its
  // subjects from the newsletter's handoff, so offering one here would promise a
  // lane the agent does not have.
  blog: "your own websites for linking, and the subjects we should never cover",
  // Leads with the routing contact, because it is the one answer whose absence
  // costs something the same day rather than degrading a draft.
  reputation: "who hears about an urgent review, and what we must never say in a reply",
  // No design questions: the look is built at setup from the client's brand
  // material, and asking here would put a second author on it.
  carousel: "the account these are for, and the subjects to never build one about",
};

/** The first thing to do in the data pane, per kind. */
const INTAKE_FIRST_STEP: Record<IntakeKind, string> = {
  x: "Save the company page below to continue.",
  linkedin: "Save the company page below to continue.",
  reddit: "Save your Reddit account below to continue.",
  // Two steps, and the band above the form owns the second. Naming only the
  // save would leave a client who has already saved reading an instruction they
  // have followed while the button beside it stays disabled.
  newsletter: "Save your details below, then set the newsletter up, to continue.",
  blog: "Save your details below, then set the blog up, to continue.",
  reputation: "Save your details below, then set the monitoring up, to continue.",
  carousel: "Save your details below, then set the carousels up, to continue.",
};

/**
 * Which intake surface governs this agent - read off the agent's own setup
 * state rather than re-derived from its key.
 *
 * Resolving it from the key meant every caller had to be handed all four
 * payloads and asked the identity question again, which is a second place for
 * "is this the LinkedIn agent" to drift from the server's answer. Now the page
 * says it once, per agent, and a state with no prefetched form yields null -
 * the href card serves that case.
 *
 * ONE EXPLICIT BRANCH PER KIND, and no trailing fallback. This used to end in a
 * bare `return { kind: "reddit", … }`, so the moment a fourth family was added
 * its state would have been relabelled Reddit on the way through - and the
 * relabelling happens HERE, upstream of everything, so the dialog title, the
 * glyph, the copy and the form itself would all have agreed with each other and
 * all been wrong. Returning null for an unrecognized kind is the safe failure:
 * the caller's href card serves it, which is exactly what a caller with no
 * payload already gets.
 */
function intakeFor(setup: AgentSetupState | null | undefined): AgentIntakeContext | null {
  if (!setup?.kind) return null;
  if (setup.kind === "x") return { kind: "x", setup: { ready: setup.ready, data: setup.data } };
  if (setup.kind === "linkedin") {
    return { kind: "linkedin", setup: { ready: setup.ready, data: setup.data } };
  }
  if (setup.kind === "reddit") {
    return { kind: "reddit", setup: { ready: setup.ready, data: setup.data } };
  }
  if (setup.kind === "newsletter") {
    return { kind: "newsletter", setup: { ready: setup.ready, data: setup.data } };
  }
  if (setup.kind === "blog") {
    return { kind: "blog", setup: { ready: setup.ready, data: setup.data } };
  }
  if (setup.kind === "reputation") {
    return { kind: "reputation", setup: { ready: setup.ready, data: setup.data } };
  }
  if (setup.kind === "carousel") {
    return { kind: "carousel", setup: { ready: setup.ready, data: setup.data } };
  }
  return null;
}

/**
 * The platform mark, per kind. Explicit for every family, same reasoning as
 * `IntakeForm`: a trailing return would have drawn the Reddit mark on the
 * newsletter's data button.
 *
 * The newsletter has no platform - it is email, sent from the client's own tool
 * - so it takes an app icon rather than a brand mark.
 */
function IntakeGlyph({ kind, className }: { kind: IntakeKind; className?: string }) {
  if (kind === "x") return <XLogo className={className} />;
  if (kind === "linkedin") return <LinkedInLogo className={className} />;
  if (kind === "newsletter") return <Icon name="Mail" className={className} />;
  if (kind === "blog") return <Icon name="PenLine" className={className} />;
  if (kind === "reputation") return <Icon name="MessageSquare" className={className} />;
  if (kind === "carousel") return <Icon name="Images" className={className} />;
  return <SocialPlatformMark platform="reddit" className={className} />;
}

/**
 * Is the company page saved? `ready` is a looser server predicate - for X, any
 * seat satisfies it, and seats are shared across agents - so it cannot decide
 * on its own whether the setup a person came here to do is finished.
 */
function companyOnFile(intake: AgentIntakeContext | null): boolean {
  return Boolean(intake?.setup.data.company);
}

/**
 * Does this agent hold everything it drafts from? Both checks read the company
 * page today, from the server predicate and from the payload respectively;
 * requiring both keeps the affordance honest if a caller's flag ever drifts
 * from the rows it ships.
 */
function intakeComplete(intake: AgentIntakeContext): boolean {
  return intake.setup.ready && companyOnFile(intake) && standUpDone(intake);
}

/**
 * Has this agent's one-time STAND-UP run happened?
 *
 * A second question from "has the client filled the form in", and FIVE families
 * have it. LinkedIn v2 derives the lanes, the voice and the first topics from a
 * run; the newsletter derives its issue index, voice card, topic pool and
 * watch-list the same way; the blog derives its post index, cluster map and
 * voice card; and reputation derives the ROSTER of the client's real listings,
 * without which a pulse has nowhere to read; and the carousel derives the style
 * config every slide obeys, without which there is no visual system at all. In both cases a client whose form is saved still has
 * nothing to draft from until that run has been, and both submit cores refuse a
 * writer run before it — so the dialog has to open where the press that starts
 * it lives, otherwise pressing Run reads as broken (a brief, a press, and a
 * refusal) rather than as a step.
 *
 * The newsletter's is the sharper case: its writer CLAIMS an issue number in the
 * index at step 01, so without one the run does not degrade, it dies — after the
 * client has been charged for it.
 *
 * TRUE for X and Reddit, because they have no such run: both draft from their
 * form directly, and answering "no" for them would park every client on a data
 * pane they have already finished.
 */
function standUpDone(intake: AgentIntakeContext): boolean {
  if (
    intake.kind !== "linkedin" &&
    intake.kind !== "newsletter" &&
    intake.kind !== "blog" &&
    intake.kind !== "reputation" &&
    intake.kind !== "carousel"
  ) {
    return true;
  }
  // Absent means "a caller that predates the flag", which is treated as done for
  // the same reason the components' own defaults are: never show a client a step
  // that is not theirs to take.
  return intake.setup.data.isSetUp !== false;
}

function IntakeForm({ intake }: { intake: AgentIntakeContext }) {
  // One explicit branch per kind on purpose, with no trailing fallback: a bare
  // final return renders another platform's form for the next kind someone adds,
  // and it does it silently — the payloads are structurally similar enough that
  // React would not complain.
  if (intake.kind === "x") return <XAgentIntake {...intake.setup.data} />;
  if (intake.kind === "linkedin") return <LinkedInAgentIntake {...intake.setup.data} />;
  if (intake.kind === "reddit") return <RedditAgentIntake {...intake.setup.data} />;
  if (intake.kind === "newsletter") return <NewsletterAgentIntake {...intake.setup.data} />;
  if (intake.kind === "blog") return <BlogAgentIntake {...intake.setup.data} />;
  if (intake.kind === "reputation") return <ReputationAgentIntake {...intake.setup.data} />;
  if (intake.kind === "carousel") return <CarouselAgentIntake {...intake.setup.data} />;
  return null;
}

/**
 * The way into an agent's data: warning-toned while the data is still missing,
 * quiet once it is on file. Opens the run dialog's data pane rather than
 * navigating - the data belongs with the agent.
 */
function AgentDataButton({
  kind,
  ready,
  onOpen,
}: {
  kind: IntakeKind;
  ready: boolean;
  onOpen: () => void;
}) {
  const className = cn(
    "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
    ready
      ? "border-border bg-surface-2 text-muted hover:border-border-strong hover:text-foreground"
      : "border-warning/30 bg-warning/10 text-warning hover:border-warning/50 hover:bg-warning/15",
  );
  const label = `${INTAKE_LABEL[kind]} agent data`;
  // The short visible text needs the platform back for anyone who cannot see
  // the glyph, and it stays inside the accessible name so voice control can
  // still say what it reads.
  const name = ready ? label : `${label}: setup needed`;
  return (
    <button type="button" onClick={onOpen} className={className} aria-label={name}>
      <IntakeGlyph kind={kind} className="h-3 w-3" />
      {ready ? label : "Setup needed"}
    </button>
  );
}

/* ═══════════════════ staff hub (/agents) ═══════════════════ */

/** Admin-only Live/Paused flip, right on the agent card - no editor round-trip. */
function AgentLiveToggle({ agentId, enabled }: { agentId: string; enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await setCustomAgentEnabledAction(agentId, !enabled);
          router.refresh();
        })
      }
      title={enabled ? "Pause this agent for clients" : "Make this agent live for clients"}
      className="disabled:opacity-50"
    >
      <Badge tone={enabled ? "success" : "neutral"} className="cursor-pointer hover:opacity-80">
        <Icon name={pending ? "Loader" : enabled ? "Zap" : "Pause"} className={cn("h-2.5 w-2.5", pending && "animate-spin")} />
        {enabled ? "Live" : "Paused"}
      </Badge>
    </button>
  );
}

/**
 * The "Custom agents" section of the staff Agents page: the stored-prompt
 * agent library. Admins import agents from the karos-agents repo catalog,
 * edit their instructions, and control which clients may fire them; anyone
 * on staff can run one for a client.
 */
/**
 * One card on the library grid: a top-level agent, the steps nested under it, and
 * whether it is an orphan whose parentKey resolves to nothing.
 */
interface LibraryEntry {
  agent: CustomAgent;
  children: CustomAgent[];
  orphan: boolean;
}

/** How much of a blocked reason fits on a badge before it breaks the card. */
const BLOCKED_LABEL_MAX = 44;

/**
 * A manifest `blocked_reason` as a badge label: the first clause, capped.
 *
 * The stored values are prose (374 to 731 characters on the agents that carry
 * one), so this takes the lead sentence or clause — which in practice is the
 * useful part ("Reddit blocks datacenter egress", "In build, no pilot run yet") —
 * and the full text rides on the title attribute beside it.
 *
 * A missing reason says so rather than falling back to the bare word that caused
 * the confusion: an agent the manifest called blocked WITHOUT saying why is a gap
 * in the manifest, and naming it is more useful than hiding it.
 */
function blockedLabel(reason: string | undefined): string {
  const text = reason?.trim();
  if (!text) return "Blocked (unspecified)";
  // First sentence or clause, whichever comes first — the values open with the
  // headline and then explain at length.
  const lead = text.split(/(?<=[.:;])\s|\s[-—]\s/)[0]?.trim() || text;
  const clipped = lead.length > BLOCKED_LABEL_MAX ? `${lead.slice(0, BLOCKED_LABEL_MAX - 1).trimEnd()}…` : lead;
  return clipped;
}

/**
 * One sub-agent, as a row nested under its parent in the library.
 *
 * NESTED RATHER THAN HIDDEN, and that is the whole design decision. /agents is
 * the LIBRARY, not a roster: it is where an admin edits an agent's instructions
 * and toggles it live. Applying the client-side filter here would make the
 * LinkedIn setup prompt permanently uneditable — a worse failure than the clutter
 * it would tidy. So a step keeps every control it had and loses only its claim to
 * be a product: no price lines (a step is not sold separately), no platform
 * badges, no card of its own.
 *
 * Run is kept for staff. Firing a step by hand is exactly what an operator needs
 * when a client's setup half-failed, and the submit core applies the same gates
 * either way.
 */
function SubAgentRow({
  agent,
  isAdmin,
  serviceConfigured,
  runnableFor,
  onEdit,
  onRun,
}: {
  agent: CustomAgent;
  isAdmin: boolean;
  serviceConfigured: boolean;
  runnableFor: number;
  onEdit: () => void;
  onRun: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-border/60 py-2 pl-3">
      <span className="text-muted-2" aria-hidden="true">
        <Icon name="CornerDownRight" className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-foreground">{agent.name}</p>
        <p className="truncate font-mono text-[10px] text-muted-2">{agent.entrySkillDir}</p>
      </div>
      {isAdmin ? (
        <AgentLiveToggle agentId={agent.id} enabled={agent.enabled} />
      ) : (
        <Badge tone={agent.enabled ? "success" : "neutral"}>
          {agent.enabled ? "Live" : "Paused"}
        </Badge>
      )}
      {isAdmin && (
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Icon name="Pencil" className="h-3.5 w-3.5" />
          <span className="sr-only">Edit {agent.name}</span>
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={!agent.enabled || !serviceConfigured || runnableFor === 0}
        title={
          !serviceConfigured
            ? "Agent service is not configured"
            : !agent.enabled
              ? "Enable this step first"
              : runnableFor === 0
                ? "No client is available to run this step for."
                : "Run this step on its own"
        }
        onClick={onRun}
      >
        <Icon name="Play" className="h-3.5 w-3.5" />
        <span className="sr-only">Run {agent.name}</span>
      </Button>
    </div>
  );
}

export function CustomAgentsHub({
  agents,
  clients,
  isAdmin,
  serviceConfigured,
  controlPlane,
}: {
  agents: CustomAgent[];
  /**
   * Control-plane facts for the agents agent-middleware knows, keyed by
   * `CustomAgent.key`. Enrichment only: an agent absent from this map renders
   * exactly as it did before, which is what keeps the unmigrated majority of
   * the library visible and runnable.
   */
  controlPlane?: ReadonlyMap<string, { agentId: string; activePromptVersion: number | null; status: string }>;
  /**
   * The lab-repo slug rides along because the hub is the one surface that pairs
   * an ARBITRARY agent with an arbitrary client: a per-client instance runs an
   * entry skill baked under the folder its key names, and both submit cores
   * refuse the wrong pair. Without the slug the hub can only offer every client
   * and let the server refuse - after the whole brief has been written (F38).
   */
  clients: Array<{ id: string; name: string; agentsRepoSlug?: string | null }>;
  isAdmin: boolean;
  serviceConfigured: boolean;
}) {
  const [runAgent, setRunAgent] = useState<CustomAgent | null>(null);
  const [editAgent, setEditAgent] = useState<CustomAgent | null>(null);
  const [creating, setCreating] = useState(false);

  // Parents carrying their own steps, then any orphan as its own card so a
  // mistyped parentKey is visible instead of swallowed.
  const { parents, orphans } = groupAgentsByParent(agents);
  const libraryEntries: LibraryEntry[] = [
    ...parents.map((entry) => ({ ...entry, orphan: false })),
    ...orphans.map((agent) => ({ agent, children: [] as CustomAgent[], orphan: true })),
  ];
  // SUPERSEDED AGENTS ARE DROPPED, not archived. `groupAgentsByParent` splits on
  // parentKey alone and a replaced agent has none — it was replaced, not absorbed
  // — so without this filter e10 LinkedIn and v1 Reddit rendered as live products
  // beside the agents that replaced them.
  //
  // This page briefly kept them in a "legacy" section so their prompts stayed
  // editable. That is no longer the rule (Ben, 2026-08-05): a superseded agent is
  // deleted from Firestore outright, so there is nothing to keep reachable and a
  // section for it would only ever be empty. The filter stays as the belt to that
  // braces — a doc that survives a deletion, or a key added to the predicate
  // before its cleanup runs, must not reappear on the hub.
  const activeEntries = libraryEntries.filter((e) => !isSupersededAgentKey(e.agent.key));

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl text-foreground">Custom agents</h2>
          <p className="mt-0.5 text-sm text-muted">
            Stored system prompts that fire a Claude session inside the karos-agents repo. Run
            with a plain-language request.
          </p>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <Icon name="Plus" className="h-3.5 w-3.5" /> New agent
            </Button>
          </div>
        )}
      </div>

      {agents.length === 0 ? (
        <div className="rounded-[var(--radius)] border border-dashed border-border px-6 py-10 text-center">
          <p className="text-sm text-foreground">No custom agents yet</p>
          <p className="mt-1 text-xs text-muted">
            {isAdmin
              ? "Create one in Agent Studio."
              : "An admin can import agents from the karos-agents repo."}
          </p>
        </div>
      ) : (
        // ONE renderer, TWO grids. The card is the same either way — a legacy
        // agent stays fully editable, which is the whole reason /agents does not
        // simply hide it — so the only difference is which section it sits in.
        (() => {
        const renderEntry = ({ agent, children, orphan }: LibraryEntry) => {
            // F38. The clients this agent can actually run for. An unbound agent
            // keeps the whole list; a per-client instance keeps its own client,
            // and keeps NONE when that client is absent from this staff member's
            // visible set or has no lab slug on file.
            const eligible = clients.filter((c) =>
              agentKeyMatchesClientSlug(agent.key, c.agentsRepoSlug),
            );
            // F35. What the card must say out loud: which workspace an instance
            // belongs to. Until now the only way to learn it was to write a
            // brief and read the refusal.
            const boundTo = perClientAgentSlug(agent.key);
            // #111. Resolved once so the badge and the price line can never
            // disagree about whether this agent has a setup price.
            const launchCost = agentLaunchCost(agent);
            return (
            <div
              key={agent.id}
              className="card-grad group relative flex min-h-52 flex-col overflow-hidden rounded-[var(--radius)] border border-border p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg"
            >
              <span className="absolute inset-x-0 top-0 h-0.5 bg-foreground/40 opacity-45 transition-opacity group-hover:opacity-80" aria-hidden="true" />
              <div className="flex items-start gap-3">
                <AgentChip agent={agent} />
                <div className="min-w-0 flex-1">
                  <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">AI agent</p>
                  <p className="truncate text-base font-medium">{agent.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-2">
                    {agent.entrySkillDir}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {/* Live/Paused: whether clients can currently launch or run
                      this agent at all. Admins can flip it right here - a
                      pause takes effect immediately (submitCustomAgentJob
                      refuses a disabled agent) and turns the agent into
                      "Coming Soon" on every client roster it was granted to. */}
                  {isAdmin ? (
                    <AgentLiveToggle agentId={agent.id} enabled={agent.enabled} />
                  ) : (
                    <Badge tone={agent.enabled ? "success" : "neutral"}>
                      {agent.enabled ? "Live" : "Paused"}
                    </Badge>
                  )}
                  {/* Intake-driven agents refuse a run whose client has not filled
                      in their data page - and that gate could only be discovered
                      by writing the whole brief and reading the refusal. The
                      readiness itself depends on the client picked inside the
                      dialog, so the hub names the gate rather than pretending to
                      resolve it. */}
                  {intakeDrivenLabel(agent.key) && (
                    <Badge tone="neutral">
                      Needs {intakeDrivenLabel(agent.key)}
                    </Badge>
                  )}
                  {/* F35: the binding, stated. An instance's entry skill is
                      baked under one client's lab folder, so this is a property
                      of the agent, not of whoever is looking at it. */}
                  {boundTo && <Badge tone="neutral">{boundTo} only</Badge>}
                  {/* Control-plane lineage, for the agents that have one. An
                      agent with a recorded prompt version runs on agent-engine
                      with that version attached to every run; one without this
                      badge runs on agent-service, which is most of them and is
                      not a defect. Absent enrichment renders nothing at all,
                      so a control plane that is down costs a badge, not a row. */}
                  {(() => {
                    const facts = controlPlane?.get(agent.key);
                    if (!facts) return null;
                    return (
                      <>
                        <Badge tone={facts.status === "active" ? "info" : "warning"}>
                          {facts.activePromptVersion === null
                            ? "Control plane · no prompt"
                            : `Control plane · prompt v${facts.activePromptVersion}`}
                        </Badge>
                        {/* The same destination an engine-only agent's card
                            offers. A library agent with a control-plane twin
                            has prompt versions, a model and template bindings
                            too; without this the only way to reach them was to
                            know the console's URL. */}
                        <Link
                          href={`/admin/agents/control-plane?agent=${encodeURIComponent(facts.agentId)}`}
                          className="text-xs underline decoration-dotted opacity-70 hover:text-neon hover:opacity-100"
                        >
                          Edit in Studio
                        </Link>
                      </>
                    );
                  })()}
                  {/* No client blurb ⇒ every client surface for this agent is
                      reading the keyed fallback rather than a line somebody
                      wrote for it. NOT the manifest below — `agentBlurb` took
                      the manifest out of the chain (F127/CD-G2). Flagged here,
                      fixed in the editor. */}
                  {!agent.clientBlurb?.trim() && <Badge tone="warning">No client blurb</Badge>}
                  {/* #111. The library flagged an unwritten blurb and said
                      nothing about an unset SETUP price, which is the stronger
                      gate: it is the rung `evaluateLaunchGate` refuses on, so a
                      client's self-serve Launch stays disabled until an admin
                      types a number in the editor. Makes the UNSET STATE
                      visible and nothing more — what the number should be is
                      Daniel's call (#167), and inventing one here would be the
                      F130 placeholder-pricing failure at the priciest SKU. */}
                  {launchCost === null && <Badge tone="warning">Setup not priced</Badge>}
                  {/* A step whose parentKey names no agent in the library. Shown
                      as a top-level card ON PURPOSE rather than dropped: a
                      swallowed orphan is an agent nobody can find or fix, and
                      the usual cause is a typo in the field. */}
                  {orphan && <Badge tone="warning">Step with no parent</Badge>}
                  {!agent.enabled && <Badge tone="warning">Disabled</Badge>}
                  {/* WHAT THE MANIFEST ACTUALLY SAID, not just that it said
                      something. `status: "blocked"` is overloaded: on the Reddit
                      agents it means Reddit blocks datacenter egress, and on the
                      v2 skills it means "in build, no pilot run yet". A bare
                      "Blocked in repo" in danger red read as a broken build to
                      every operator who saw it, which is why this is now the
                      reason, in warning tone.

                      Shown for an ENABLED agent too, unlike before: the manifest
                      status is a live fact about the skill, and an operator who
                      has switched a blocked agent on is exactly the person who
                      needs to remember why it was blocked.

                      Truncated, because the real values run 374 to 731 characters
                      and a badge that long destroys the card. The whole reason is
                      on the title attribute, which is the only place it fits. */}
                  {agent.source?.status === "blocked" && (
                    <span title={agent.source.blocked_reason ?? "No reason recorded in the manifest."}>
                      <Badge tone="warning">{blockedLabel(agent.source.blocked_reason)}</Badge>
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-2">
                {agent.description || "No description."}
              </p>
              <div className="mt-3">
                <AgentPlatformBadges identity={`${agent.key} ${agent.name}`} />
              </div>
              <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                {/* BOTH prices, because only one of them gates anything. The
                    per-run line read as "this agent is priced" while the setup
                    price — the one the client's Launch button waits on — was
                    invisible whether it was set or not. */}
                <div className="min-w-0">
                  <p className="text-xs text-muted-2">
                    {/* × the fresh dialog's visible batch default (1 today for
                        every agent): what one untouched client press charges. */}
                    {creditsLabel(
                      agentRunCost(agent) *
                        defaultRunBatchSize({ key: agent.key, name: agent.name }),
                    )}{" "}
                    per client run
                  </p>
                  {launchCost === null ? (
                    <p className="mt-0.5 text-xs text-warning">
                      Setup not priced. Clients cannot launch it themselves
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-muted-2">
                      {creditsLabel(launchCost)} one-time setup
                    </p>
                  )}
                </div>
                <div className="flex gap-1.5">
                  {isAdmin && (
                    <Button size="sm" variant="ghost" onClick={() => setEditAgent(agent)}>
                      <Icon name="Pencil" className="h-3.5 w-3.5" /> Edit
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="subtle"
                    // F38. No eligible client ⇒ every pair this dialog could
                    // build is one the server refuses, so the refusal is stated
                    // here instead of after the brief is written.
                    disabled={!agent.enabled || !serviceConfigured || eligible.length === 0}
                    title={
                      !serviceConfigured
                        ? "Agent service is not configured"
                        : !agent.enabled
                          ? "Enable this agent first"
                          : eligible.length === 0
                            ? boundTo
                              ? `This agent runs only for the "${boundTo}" workspace, and no client you can see has that lab repo slug.`
                              : "No client is available to run this agent for."
                            : undefined
                    }
                    onClick={() => setRunAgent(agent)}
                  >
                    <Icon name="Play" className="h-3.5 w-3.5" /> Run
                  </Button>
                </div>
              </div>
              {/* The steps that belong to this agent. Structural, from each
                  document's own parentKey — so an agent that grows a step later
                  nests here with no change to this file. */}
              {children.length > 0 && (
                <div className="mt-4">
                  <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">
                    Steps of this agent
                  </p>
                  <div className="mt-1">
                    {children.map((child) => (
                      <SubAgentRow
                        key={child.id}
                        agent={child}
                        isAdmin={isAdmin}
                        serviceConfigured={serviceConfigured}
                        runnableFor={
                          clients.filter((c) =>
                            agentKeyMatchesClientSlug(child.key, c.agentsRepoSlug),
                          ).length
                        }
                        onEdit={() => setEditAgent(child)}
                        onRun={() => setRunAgent(child)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
            );
        };
        return <div className="grid gap-3 sm:grid-cols-2">{activeEntries.map(renderEntry)}</div>;
        })()
      )}

      {runAgent && (
        <RunCustomAgentModal
          agent={runAgent}
          // Only the clients this agent can draft for reach the picker, so a
          // staff member cannot assemble a pair the submit core refuses.
          clients={clients.filter((c) =>
            agentKeyMatchesClientSlug(runAgent.key, c.agentsRepoSlug),
          )}
          contextItems={[]}
          viewerIsClient={false}
          onClose={() => setRunAgent(null)}
        />
      )}
      {(editAgent || creating) && (
        <AgentEditorModal
          agent={editAgent}
          onClose={() => {
            setEditAgent(null);
            setCreating(false);
          }}
        />
      )}
    </section>
  );
}

/* ═════════════════ staff controls (agent detail page) ═════════════════ */

/**
 * Does this refusal name a setup problem the reader can go and fix?
 *
 * All FOUR intake prefixes, which is the point: the Reddit one was missing once,
 * so a staff member whose Reddit schedule was refused for want of intake got
 * the "contact us" row - advice to email somebody about a form they were one
 * click from filling in - while the identical X and LinkedIn refusals offered
 * the link. The four agents are gated the same way by the submit cores, so
 * they recover the same way here.
 */
function refusalNamesSetup(refusal: string): boolean {
  return (
    refusal.startsWith(X_SETUP_REQUIRED_PREFIX) ||
    refusal.startsWith(LINKEDIN_SETUP_REQUIRED_PREFIX) ||
    refusal.startsWith(REDDIT_SETUP_REQUIRED_PREFIX) ||
    refusal.startsWith(NEWSLETTER_SETUP_REQUIRED_PREFIX) ||
    refusal.startsWith(BLOG_SETUP_REQUIRED_PREFIX) ||
    refusal.startsWith(REPUTATION_SETUP_REQUIRED_PREFIX) ||
    refusal.startsWith(CAROUSEL_SETUP_REQUIRED_PREFIX)
  );
}

/**
 * Everything staff can DO to one agent for one client (CD-I1 staff parity).
 *
 * The staff all-in-one card grid is retired: staff now click an agent on the
 * roster and open the same full page a client opens, which is the second half
 * of Albert's directive. That move is only honest if nothing staff could do
 * before becomes unreachable, so this band carries the four capabilities that
 * lived on the retired card - run now, set/manage the schedule, reach the
 * agent's data, and read why a schedule is refusing - and the detail page
 * mounts the curation pane and the economics card beside it.
 *
 * STAFF ONLY, and simpler for it: staff runs are free (isBillableClientActor),
 * so there is no credit rung here at all. The client's own run gesture lives in
 * AgentDetailPanel / LegacyAgentPanel, where the price and the gate are, and
 * this component is never mounted for a client viewer.
 */
export function StaffAgentControls({
  clientId,
  agent,
  schedule,
  setup,
  contextItems,
  reviewCount = 0,
  reviewHref,
  lastRunAt,
  viewer,
}: {
  clientId: string;
  agent: RunnableAgentSummary;
  schedule?: ClientAgentScheduleRow;
  setup?: AgentSetupState;
  contextItems: ContextItem[];
  /** Deliverables sitting in review for this agent - the staff queue. */
  reviewCount?: number;
  reviewHref: string;
  lastRunAt?: number;
  viewer?: { name: string; email: string };
}) {
  const [runOpen, setRunOpen] = useState(false);
  const [runIntakeFirst, setRunIntakeFirst] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const intake = intakeFor(setup);
  const blockedSetup = setup && !setup.ready ? setup : null;
  // A refused schedule is never "Live". A PAUSED schedule reports paused: the
  // person who paused it chose that, and a stale refusal from before the pause
  // is not the current state.
  const refusal = schedule?.status === "active" ? schedule.lastError?.trim() || null : null;
  const refusalIsSetup = refusal !== null && refusalNamesSetup(refusal);
  // A scheduled run fires unattended, so every fire would be refused while the
  // company page is missing. An EXISTING schedule stays open to manage -
  // pausing it must never be blocked.
  const scheduleNeedsData =
    Boolean(intake) && (!companyOnFile(intake) || !standUpDone(intake!)) && !schedule;

  function openRun(intakeFirst = false) {
    setRunIntakeFirst(intakeFirst);
    setRunOpen(true);
  }

  return (
    <section className="rounded-[var(--radius)] border border-border bg-surface-2/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
          Staff controls
        </h2>
        <AgentPlatformBadges identity={`${agent.key} ${agent.name}`} />
        {/* Two affordances, never both at once. Missing data is a CALL TO
            ACTION and links the agent's own data page (CD-E1); data already on
            file is an EDIT affordance and opens the dialog's inline pane, so a
            staff member correcting one field does not lose the run they were
            setting up. */}
        {blockedSetup ? (
          <a
            href={blockedSetup.href}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40"
            title={`Open ${blockedSetup.label} to finish setup`}
          >
            <Badge tone="warning">Setup needed</Badge>
          </a>
        ) : intake && intakeComplete(intake) ? (
          <AgentDataButton kind={intake.kind} ready onOpen={() => openRun(true)} />
        ) : null}
      </div>

      {/* The live-state slot. Precedence, highest first: a stored refusal (the
          schedule fired and was turned away) → setup still missing → the
          schedule's own next fire → drafts waiting → last run → never run. */}
      <div className="rounded-md border border-border bg-surface-2/70 px-3 py-2">
        {schedule && (
          <p className="text-xs text-foreground">
            {schedule.postsPerWeek} run{schedule.postsPerWeek === 1 ? "" : "s"}/week
            {" · "}
            {schedule.outputsPerRun} output{schedule.outputsPerRun === 1 ? "" : "s"} each
          </p>
        )}
        {refusal ? (
          <>
            <p className="mt-0.5 text-[11px] text-warning">{refusal}</p>
            {refusalIsSetup && setup ? (
              <a
                href={setup.href}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-neon hover:underline"
              >
                Open {setup.label}
                <Icon name="ArrowRight" className="h-3 w-3" />
              </a>
            ) : viewer ? (
              <div className="-mx-3 mt-0.5">
                <ContactUsButton variant="row" userName={viewer.name} userEmail={viewer.email} />
              </div>
            ) : null}
            {schedule?.lastErrorAt ? (
              <p className="mt-0.5 text-[10px] text-muted-2">
                Last tried {relativeTime(schedule.lastErrorAt)}
              </p>
            ) : null}
          </>
        ) : blockedSetup ? (
          <p className={cn("text-[11px] text-warning", !schedule && "text-xs")}>
            Not running yet. Your {blockedSetup.label} is still empty.
          </p>
        ) : schedule ? (
          <p className="mt-0.5 text-[11px] text-muted-2">
            {schedule.status === "active"
              ? `Working toward ${formatDate(schedule.nextRunAt)}`
              : "Schedule paused"}
          </p>
        ) : reviewCount > 0 ? (
          <Link href={reviewHref} className="text-xs text-warning hover:underline">
            {reviewCount} draft{reviewCount === 1 ? "" : "s"} waiting for review
          </Link>
        ) : lastRunAt ? (
          <p className="text-xs text-muted-2">Last run {relativeTime(lastRunAt)}</p>
        ) : (
          <p className="text-xs text-muted-2">No runs yet.</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          // F131: a control the server would refuse is never left enabled.
          // Missing intake is exactly such a refusal, so the chip above is the
          // way in, not this button.
          disabled={Boolean(blockedSetup)}
          onClick={() => openRun()}
        >
          <Icon name="Play" className="h-3.5 w-3.5" /> Run now
        </Button>
        <Button
          size="sm"
          variant="subtle"
          onClick={() => (scheduleNeedsData ? openRun(true) : setScheduleOpen(true))}
        >
          <Icon name="SlidersHorizontal" className="h-3.5 w-3.5" />
          {schedule ? "Manage schedule" : "Set schedule"}
        </Button>
        {reviewCount > 0 && (
          <Link
            href={reviewHref}
            className="inline-flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning transition-colors hover:border-warning/50 hover:bg-warning/15"
          >
            <Icon name="Bell" className="h-3.5 w-3.5" />
            {reviewCount} ready
          </Link>
        )}
      </div>

      {/* Why a control is off, PAINTED - the Button primitive sets
          disabled:pointer-events-none, so a title on a disabled button can
          never be shown. */}
      {blockedSetup && (
        <p className="mt-2 border-t border-border/60 pt-2 text-[11px] text-warning">
          Run now needs the {blockedSetup.label}. This agent drafts from it.
        </p>
      )}
      {scheduleNeedsData && intake && !blockedSetup && (
        <p className="mt-2 text-[11px] text-muted-2">
          Add the {INTAKE_LABEL[intake.kind]} agent data before setting a schedule. Every
          scheduled run drafts from it.
        </p>
      )}

      {runOpen && (
        <RunCustomAgentModal
          agent={agent}
          clientId={clientId}
          contextItems={contextItems}
          viewerIsClient={false}
          {...(setup ? { setup } : {})}
          {...(runIntakeFirst ? { initialPane: "data" as const } : {})}
          // AF-9. These controls only ever render inside the Control Room on an
          // agent's own detail page, and that page is what the operator came to
          // read — a redirect to the raw job record threw away the tab they had
          // open and everything else on the agent with it.
          stayOnPage
          onClose={() => setRunOpen(false)}
        />
      )}
      {scheduleOpen && (
        <AgentScheduleModal
          agent={agent}
          clientId={clientId}
          {...(schedule ? { schedule } : {})}
          {...(intake && (!companyOnFile(intake) || !standUpDone(intake))
            ? {
                setupNeeded: {
                  kind: intake.kind,
                  onOpenData: () => {
                    setScheduleOpen(false);
                    openRun(true);
                  },
                },
              }
            : {})}
          onClose={() => setScheduleOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * Control Room "Test Run" (item 3's dry-run equivalent) - staff only. The
 * agent-service has no dry-run parameter, so this fires for real: same cost,
 * same generation. What's different is what happens to the OUTPUT afterward
 * - runCustomAgentTestAction stamps runType: "test", which the webhook reads
 * to keep the resulting draft off the calendar and every client-facing
 * surface (asset-visibility.ts's isTestRunAsset, mirroring the existing
 * launchDeliverable exclusion). Deliberately a simpler form than
 * RunCustomAgentModal - no client picker (already scoped to one client), no
 * intake/attachment dance (a staff member testing the pipeline can just type
 * a brief) - reusing that heavier modal here would drag in machinery this
 * flow doesn't need.
 */
export function TestRunButton({ agentId, clientId }: { agentId: string; clientId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit() {
    if (!prompt.trim()) {
      setError("Add a brief to test.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await runCustomAgentTestAction({ agentId, clientId, prompt: prompt.trim() });
      if (result.error) {
        setError(result.error);
        return;
      }
      setDone(true);
      router.refresh();
    });
  }

  function close() {
    setOpen(false);
    setPrompt("");
    setError(null);
    setDone(false);
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Icon name="FlaskConical" className="h-3.5 w-3.5" /> Test run
      </Button>
      {open && (
        <Modal open onClose={close} title="Test run">
          {done ? (
            <div className="mt-4 space-y-3 text-center">
              <Icon name="CircleCheck" className="mx-auto h-8 w-8 text-success" />
              <p className="text-sm text-foreground">Test run started</p>
              <p className="text-xs text-muted-2">
                Real generation, real cost. The output is flagged TEST and will never reach the
                client&apos;s Workspace, the calendar, or scheduling. Find it under Outputs &amp;
                Artifacts once it lands, with Promote/Dismiss actions.
              </p>
              <Button variant="subtle" onClick={close}>
                Done
              </Button>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <p className="text-xs text-muted-2">
                Fires for real. Same cost, same generation. To verify this agent&apos;s prompt and
                context pipeline still produce good output. The result never reaches the client,
                the calendar, or scheduling.
              </p>
              <Textarea
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should this test run ask the agent to do?"
              />
              {error && <p className="text-xs text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={close} disabled={pending}>
                  Cancel
                </Button>
                <Button onClick={submit} loading={pending}>
                  Run test
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

/**
 * Recent agent runs - the staff history strip (CD-I1).
 *
 * Lifted out of the retired card grid rather than rewritten, and kept on BOTH
 * staff surfaces: the roster page shows every agent's runs (the cross-agent
 * view staff had before and would otherwise lose to per-agent pages), and the
 * detail page shows one agent's. Client viewers never mount it - their run
 * history is the archive, and a raw prompt or a /jobs link is staff-only.
 */
export function AgentRunHistory({
  runs,
  agents,
  heading = "Recent agent runs",
}: {
  runs: CustomAgentRunRow[];
  /** For the platform mark - matched on the stored name, as the rows are. */
  agents: RunnableAgentSummary[];
  heading?: string;
}) {
  const agentByName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);
  if (runs.length === 0) return null;
  // Item 4's execution-state visibility, computed off the same rows the list
  // below already has - no second fetch, just a count.
  const stateCounts = runs.reduce(
    (acc, r) => {
      if (r.status === "queued") acc.queued++;
      else if (r.status === "running") acc.running++;
      else if (r.status === "failed") acc.failed++;
      else if (r.status === "delivered" || r.status === "approved") acc.succeeded++;
      return acc;
    },
    { queued: 0, running: 0, succeeded: 0, failed: 0 },
  );
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">{heading}</p>
        <div className="flex items-center gap-2.5 text-[11px] text-muted-2">
          {stateCounts.queued > 0 && <span>{stateCounts.queued} queued</span>}
          {stateCounts.running > 0 && <span>{stateCounts.running} running</span>}
          <span>{stateCounts.succeeded} succeeded</span>
          {stateCounts.failed > 0 && <span className="text-danger">{stateCounts.failed} failed</span>}
        </div>
      </div>
      <div className="overflow-hidden rounded-[var(--radius)] border border-border">
        {runs.map((run, i) => {
          const agent = agentByName.get(run.agentName);
          const classifiedError = run.status === "failed" ? classifyJobError(run.error) : null;
          const elapsed = run.status === "running" ? relativeTime(run.createdAt) : null;
          const row = (
            <>
              {agent ? (
                <AgentIdentity
                  identity={`${agent.key} ${agent.name}`}
                  icon={agent.icon}
                  size="sm"
                />
              ) : (
                <AgentIdentity identity={run.label} icon="Bot" size="sm" />
              )}
              <div className="min-w-0 flex-1">
                {/* The resolved identity, never the stored name (F147). */}
                <p className="truncate text-sm">{run.label}</p>
                {/* What the run produced - never what somebody typed to start
                    it, for a client. `prompt` is present only for staff. */}
                <p className="truncate text-xs text-muted-2">
                  {relativeTime(run.createdAt)}
                  {run.assetCount > 0
                    ? ` · ${run.assetCount} draft${run.assetCount === 1 ? "" : "s"}`
                    : ""}
                  {run.prompt ? ` · "${run.prompt}"` : ""}
                </p>
                {/* Honest timeline (no fabricated step count - the agent-service
                    reports only terminal outcomes, see job-error-taxonomy.ts /
                    agent-health.ts doc comments): queued → working (elapsed) →
                    the classified error, or nothing more once it's done. */}
                {classifiedError && (
                  <p className="mt-0.5 truncate text-xs text-danger" title={classifiedError.raw}>
                    {classifiedError.label}
                  </p>
                )}
              </div>
              {run.runType === "test" && <Badge tone="warning">TEST</Badge>}
              <JobStatusBadge status={run.status} />
            </>
          );
          const rowClass = cn(
            "flex items-center gap-3 px-4 py-2.5",
            i > 0 && "border-t border-border",
          );
          const inFlight = run.status === "queued" || run.status === "running";
          return (
            <div key={run.id}>
              {run.href ? (
                <Link href={run.href} className={cn(rowClass, "transition-colors hover:bg-surface-2")}>
                  {row}
                  <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
                </Link>
              ) : (
                <div className={rowClass}>{row}</div>
              )}
              {inFlight && (
                <div className="border-t border-border bg-surface-2/50">
                  <ManagedJobProgress
                    status={run.status}
                    className="mb-0 rounded-none border-0 bg-transparent px-4 py-2"
                  />
                  {elapsed && (
                    <p className="px-4 pb-1 text-[11px] text-muted-2">Working. Started {elapsed}</p>
                  )}
                  <CancelRunControl runId={run.id} staffFastReconcile />
                </div>
              )}
              {/* Item 4: a failed run used to be a dead end - the only way to
                  try again was firing a brand-new run by hand. Re-submits with
                  the same agent/client/prompt via retryJobAction. Labeled plainly
                  as a full re-run, not "resume from failed step" - there is no
                  step-level signal to resume FROM (see job-error-taxonomy.ts). */}
              {run.status === "failed" && (
                <div className="border-t border-border bg-surface-2/50">
                  <RetryRunControl runId={run.id} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Stop an in-flight run. The only cancel control used to live on the staff
 * run-detail page, so a client who mis-fired a twenty-five-minute billable run
 * could not stop it and could not reach the page that could. The confirm step
 * is deliberate: cancelling costs the run, and on the staff hub the row sits
 * one pixel from rows that are merely history.
 *
 * EXPORTED because CD-G1 took the client's only mount away with it (F30
 * regression). Dropping ClientCustomAgents from the client branch left this
 * control mounted on the staff hub alone, so the client-authorized action
 * behind it - cancelClientAgentJobAction, which authorizes on the JOB's own
 * clientId - had no surface. The agent DETAIL page is where a client now meets
 * their in-flight run, so that is where the control goes: one implementation,
 * one action, one confirm step, on both panels.
 */
export function CancelRunControl({
  runId,
  refunds = true,
  staffFastReconcile = false,
}: {
  runId: string;
  /**
   * Whether stopping this run actually returns credits - i.e. whether the
   * viewer was charged for it. Staff and impersonated sessions never spend
   * (isBillableClientActor), so promising them a refund describes a ledger
   * entry that does not exist. Default true: the client pressing their own
   * Run button is the common case and it IS billed.
   */
  refunds?: boolean;
  /**
   * Control Room's "Force Cancel" (staff only, default false - this component
   * is shared with the client-facing activeRun banner, which cannot call a
   * requireStaff() action). `cancelClientAgentJobAction` only asks the agent-
   * service to stop the run; locally the job stays queued/running until a
   * webhook arrives or the ~10-minute reconcile cron sweeps it. When true,
   * this fires `refreshJobStatusAction` right after - the same reconcile
   * logic the cron uses - so the row reflects the real terminal state in
   * seconds instead of up to the cron's full interval.
   */
  staffFastReconcile?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cancel() {
    setError(null);
    startTransition(async () => {
      // The action does not only RETURN errors - requireClientAccess throws
      // ("Unauthorized" / "Forbidden"), and a network failure on the server
      // action itself rejects. Unhandled, that escaped the transition and took
      // the whole route to the error boundary: a client whose session had
      // expired mid-run lost the page instead of reading one line. The row
      // already has somewhere to say so.
      try {
        const result = await cancelClientAgentJobAction(runId);
        if (result.error) {
          setError(result.error);
          setConfirming(false);
          return;
        }
        if (staffFastReconcile) {
          await refreshJobStatusAction(runId).catch(() => {});
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't stop this run.");
        setConfirming(false);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
      {confirming ? (
        <>
          <span className="text-[11px] text-muted">
            {refunds ? "Stop this run? Credits for it are returned." : "Stop this run?"}
          </span>
          <Button size="sm" variant="danger" onClick={cancel} loading={pending}>
            Stop run
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
            Keep going
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          <Icon name="CircleSlash" className="h-3.5 w-3.5" /> Cancel run
        </Button>
      )}
      {error && (
        <span className="text-[11px] text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Re-fire a failed run with the same agent/client/prompt (retryJobAction).
 * Staff-only surface - mounted only from AgentRunHistory, which never renders
 * for client viewers (see its own doc comment).
 */
function RetryRunControl({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function retry() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await retryJobAction(runId);
        if (result.error) {
          setError(result.error);
          return;
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't retry this run.");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
      <Button size="sm" variant="ghost" onClick={retry} loading={pending}>
        <Icon name="RotateCw" className="h-3.5 w-3.5" /> Retry run
      </Button>
      {error && (
        <span className="text-[11px] text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Exported so the live client-agent card's "Adjust pace" reuses THIS dialog
 * rather than growing a second schedule UI over the same action. One dialog,
 * one `configureClientAgentScheduleAction`, one set of clamps.
 *
 * `paceOnly` is the CLIENT face of it, and it exists for the churn rule (D3,
 * A3/A4). The staff dialog has two dials because the schedule really has two
 * dimensions: how many days the agent fires, and how many items each fire
 * produces. Shown to a client, that second dial states the batch shape outright
 * - "3 runs × 5 outputs = 15 drafts a week" tells them their week is generated
 * in lumps ahead of time, which is exactly what the week strip is careful never
 * to reveal. A client may be told the PACE (how many posts a week, which days),
 * never the batching that produces it.
 *
 * So the client form offers one number - the days it actually changes - and
 * READS the stored outputs-per-run into the weekly cost and the save payload
 * rather than pinning it: a pinned 1 both under-quoted a 3×5 schedule's price
 * and silently rewrote it on save (delta-lens bounce). The label decomposes
 * nothing: "Posts per week" when one output per fire is stored, otherwise
 * "Posting days a week". The server independently preserves stored
 * outputsPerRun and prompt for client actors (planned-run-actions).
 */
export function AgentScheduleModal({
  agent,
  clientId,
  schedule,
  availableCredits,
  paceOnly = false,
  setupNeeded,
  onClose,
}: {
  agent: RunnableAgentSummary;
  clientId: string;
  schedule?: ClientAgentScheduleRow;
  availableCredits?: number;
  /** Client viewers: pace language only, no batch dial. */
  paceOnly?: boolean;
  /** Set when this agent drafts from intake and its company page is missing. */
  setupNeeded?: { kind: IntakeKind; onOpenData: () => void };
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Per-agent ceilings (F27). Clamped on the way IN as well: a stored row
  // written before the cap existed would otherwise seed a value the dropdown
  // cannot show, which renders as an empty select.
  const limits = scheduleLimitsFor(agent.key);
  const [postsPerWeek, setPostsPerWeek] = useState(
    Math.min(schedule?.postsPerWeek ?? 3, limits.maxRunsPerWeek),
  );
  // ALWAYS the stored value, in both faces of the dialog. Pinning this to 1 for
  // paceOnly (as it briefly did) was two bugs in one: a schedule stored at 3×5
  // quoted its weekly cost from 3×1 - five times under - and pressing "Save
  // pace" then wrote that 1 back, silently cutting the client's output to a
  // fifth of what they were paying for. A client adjusting pace changes which
  // DAYS the agent fires, and nothing else; the server enforces the same rule
  // rather than trusting this value (configureClientAgentScheduleAction).
  const [outputsPerRun, setOutputsPerRun] = useState(
    Math.min(schedule?.outputsPerRun ?? 1, limits.maxOutputsPerRun),
  );
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "Create the next on-brand post for our audience.");
  const [time, setTime] = useState(
    `${String(schedule?.hour ?? 9).padStart(2, "0")}:${String(schedule?.minute ?? 0).padStart(2, "0")}`,
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const costPerOutput = agentRunCost(agent);
  const weeklyCost = scheduledAgentWeeklyCost(costPerOutput, postsPerWeek, outputsPerRun);
  const insufficient = availableCredits !== undefined && availableCredits < costPerOutput * outputsPerRun;
  // Nothing unattended can start before the agent has what it drafts from.
  // A schedule that already exists stays editable, so it can still be paused.
  const blockedBySetup = Boolean(setupNeeded) && !schedule;

  function save() {
    setError(null);
    // A cleared time field used to save 00:00. `"".split(":").map(Number)` is
    // `[0]`, so hour became 0 and minute undefined, and the server had no way
    // to tell that from a client who genuinely picked midnight — one slip moved
    // every future post to the middle of the night. Nothing is submitted until
    // the time reads as a time; 00:00 still parses, because midnight is a
    // choice a client is allowed to make.
    const timing = validateScheduleTiming({
      time,
      // Swept as the payload, not as a list: whatever numbers this save is
      // about to send are the numbers checked.
      counts: { postsPerWeek, outputsPerRun },
    });
    if (!timing.ok) {
      setError(timing.error);
      return;
    }
    const { hour, minute } = timing;
    startTransition(async () => {
      const result = await configureClientAgentScheduleAction({
        clientId,
        customAgentId: agent.id,
        postsPerWeek,
        outputsPerRun,
        prompt,
        hour,
        minute,
        // The time above is a wall clock the client typed in THEIR zone; without
        // this the schedule silently anchors to the server's.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  function togglePause() {
    if (!schedule) return;
    startTransition(async () => {
      const result = await setPlannedRunStatusAction(
        schedule.id,
        schedule.status === "active" ? "paused" : "active",
      );
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  // Staff-only permanent stop, same primitive and confirm-then-act shape as the
  // "Delete schedule" control on the calendar's active-run card (run-calendar.tsx)
  // — this modal was the one surface that could set a pace or pause it, but never
  // retire it, so a paused schedule had no route past "sits paused forever".
  function stop() {
    if (!schedule) return;
    startTransition(async () => {
      const result = await deletePlannedRunAction(schedule.id);
      if (result.error) {
        setError(result.error);
        setConfirmingStop(false);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={paceOnly ? `${agent.name} pace` : `Keep ${agent.name} running`}
      description={
        paceOnly
          ? "How often this agent posts for you. Change it whenever you like. It takes effect from the next post."
          : "Choose the weekly production pace. New outputs are created as drafts and placed into your content workflow."
      }
      footer={
        confirmingStop ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-danger">
              Stop this schedule permanently? The agent won&apos;t run on this cadence again, and
              it can&apos;t be undone. To stop it temporarily, pause it instead.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" onClick={() => setConfirmingStop(false)} disabled={pending}>
                Keep it
              </Button>
              <Button variant="danger" onClick={stop} loading={pending}>
                Yes, stop it
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-2">
              {schedule && (
                <Button variant="ghost" onClick={togglePause} loading={pending}>
                  {schedule.status === "active" ? "Pause agent" : "Resume agent"}
                </Button>
              )}
              {/* Staff only — a client's undo for a retired schedule is a staff
                  member, same rule deletePlannedRunAction already enforces
                  server-side (authorizeClient/requireStaff). */}
              {!paceOnly && schedule && (
                <Button variant="ghost" onClick={() => setConfirmingStop(true)} disabled={pending}>
                  Stop schedule
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
              <Button
                variant="accent"
                onClick={save}
                loading={pending}
                // Setup missing ⇒ every fire this schedule writes would be
                // refused, so the control that writes it is not left enabled.
                disabled={insufficient || blockedBySetup}
              >
                {paceOnly
                  ? schedule
                    ? "Save pace"
                    : "Start posting"
                  : schedule
                    ? "Update schedule"
                    : "Start always-on agent"}
              </Button>
            </div>
          </div>
        )
      }
    >
      <div className="space-y-4">
        <div className={cn("grid gap-3", paceOnly ? "grid-cols-1" : "grid-cols-2")}>
          <div>
            {/* Staff see RUNS (days the agent fires) beside outputs-per-fire.
                Clients see one dial. It is labelled "Posts per week" only when
                that is literally true (one output per fire); when a staff member
                has set more, the honest client-side name for the same dial is
                the number of DAYS - which the ruling allows ("the modal may name
                pace: posts per week, days") and which states no batch shape. */}
            <Label htmlFor={`schedule-posts-${agent.id}`}>
              {paceOnly
                ? outputsPerRun === 1
                  ? "Posts per week"
                  : "Posting days a week"
                : "Runs per week"}
            </Label>
            <Select
              id={`schedule-posts-${agent.id}`}
              value={postsPerWeek}
              onChange={(event) => setPostsPerWeek(Number(event.target.value))}
            >
              {countOptions(limits.maxRunsPerWeek).map((count) => (
                <option key={count} value={count}>{count}</option>
              ))}
            </Select>
          </div>
          {!paceOnly && (
            <div>
              <Label htmlFor={`schedule-outputs-${agent.id}`}>Outputs per run</Label>
              <Select
                id={`schedule-outputs-${agent.id}`}
                value={outputsPerRun}
                onChange={(event) => setOutputsPerRun(Number(event.target.value))}
              >
                {countOptions(limits.maxOutputsPerRun).map((count) => (
                  <option key={count} value={count}>{count}</option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <div>
          <Label htmlFor={`schedule-time-${agent.id}`}>
            {paceOnly ? "Time of day" : "Production time"}
          </Label>
          <Input
            id={`schedule-time-${agent.id}`}
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>

        {/* STAFF ONLY. This is the operator's standing instruction to the agent
            - internal copy, written for the model - and it was rendering in the
            client's pace dialog as an editable textarea. That showed a client
            text never written for them AND let them rewrite the direction every
            future run receives. Clients steer their agent through feedback,
            which is written for that purpose and is capped, scoped and
            reviewable; this is not that. The server also refuses to take a
            prompt from a client actor, so hiding it is the second lock. */}
        {!paceOnly && (
          <div>
            <Label htmlFor={`schedule-prompt-${agent.id}`}>Ongoing direction</Label>
            <Textarea
              id={`schedule-prompt-${agent.id}`}
              rows={3}
              maxLength={4000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>
        )}

        <div className="rounded-md border border-neon/20 bg-neon-soft/40 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-foreground">Estimated weekly cost</span>
            <span className="font-mono text-sm text-neon">{creditsLabel(weeklyCost)}</span>
          </div>
          {paceOnly ? (
            /* The weekly total above is computed from the STORED multiplier, so
               it is the real number. What it must not do is decompose: no
               "runs", no "outputs per run", no weekly draft total - each of
               those describes the batch rather than the pace. When one post per
               fire is stored there is no batch to hide and the friendlier
               sentence is also the true one.

               WHEN THE MONEY ACTUALLY MOVES (#32). This said "Credits are
               charged as each post is made", which is a lying state on a screen
               about money — nothing charges at the moment a post is produced,
               and nothing charges at publish. The scheduler's fire path
               (/api/run-scheduled → submitCustomAgentJob) charges UPFRONT, once,
               before the agent has written anything, and it charges for the
               whole fire: `chargeMultiplier = outputsPerRun`, so the amount is
               the per-output price times the outputs that fire will produce.
               A fire that delivers nothing is refunded in full (the webhook's
               zero-deliverable and failure refunds); a fire that delivers SOME
               of its batch is not, which is why only the one-post-per-fire
               branch below may promise the credits back for a missing post. */
            <p className="mt-1 text-[11px] text-muted-2">
              {outputsPerRun === 1
                ? `${postsPerWeek} post${postsPerWeek === 1 ? "" : "s"} a week at ${creditsLabel(costPerOutput)} each. A post's credits are charged when the agent starts drafting it, not when it goes out; if the post never arrives, they are handed back.`
                : `${postsPerWeek} posting day${postsPerWeek === 1 ? "" : "s"} a week. A day's credits are charged in full when the agent starts drafting for it, not as posts go out.`}
            </p>
          ) : (
            <>
              <p className="mt-1 text-[11px] text-muted-2">
                {postsPerWeek} run{postsPerWeek === 1 ? "" : "s"} × {outputsPerRun} output
                {outputsPerRun === 1 ? "" : "s"} × {creditsLabel(costPerOutput)}.
                Credits are charged in full when each scheduled run starts, and refunded
                if it delivers nothing.
              </p>
              <p className="mt-1 text-[11px] text-foreground">
                {postsPerWeek * outputsPerRun} new draft
                {postsPerWeek * outputsPerRun === 1 ? "" : "s"} a week.
              </p>
            </>
          )}
          {availableCredits !== undefined && (
            <p className={cn("mt-1 text-[11px]", insufficient ? "text-danger" : "text-muted-2")}>
              {creditsLabel(availableCredits)} currently available.
            </p>
          )}
        </div>

        {/* WHY SAVE IS OFF, when it is off because of credits (AF-10).
            `insufficient` has disabled the primary button since F27, and the
            only sign of it was the availability line above turning red — a
            disabled control whose reason is a colour on a different sentence,
            which is the F25 shape exactly. A client out of credits pressed
            nothing, read "0 credits currently available.", and was told neither
            that the button was dead nor what to do about it.

            The WORDING is the shared one (`CREDIT_BLOCK_REASON`), not a line of
            this dialog's own: the run gates beside it already refuse in those
            words, and a client who meets the refusal here and again on the run
            button must not read two different explanations of one balance.
            Staff never see it — `availableCredits` is undefined for them, so
            `insufficient` is false. */}
        {insufficient && (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
            <p className="text-xs text-warning">{CREDIT_BLOCK_REASON.insufficient_balance}</p>
            {/* Precisely what is and is not off: Pause is never disabled by
                the balance, and promising "you can still change the pace" would
                be describing the very button that just went dead. */}
            <p className="mt-0.5 text-[11px] text-muted-2">
              You can still pause this agent. Saving a new pace works again once your balance is
              topped up.
            </p>
          </div>
        )}
        {blockedBySetup && setupNeeded && (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            Add the {INTAKE_LABEL[setupNeeded.kind]} agent data first. Every scheduled run drafts
            from it, so none can start until it is saved.{" "}
            <button
              type="button"
              onClick={setupNeeded.onOpenData}
              className="cursor-pointer underline"
            >
              Open {INTAKE_LABEL[setupNeeded.kind]} agent data →
            </button>
          </p>
        )}

        {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/* ═══════════════════════ run dialog ═══════════════════════ */

/** The brief, or the agent's own data form - the intake-driven agents own both. */
type RunPane = "run" | "data";

/**
 * Exported so the agent DETAIL page can offer the same run gesture for an
 * agent that has a live schedule but no umbrella (CD-H8). One dialog, one
 * launch profile, one charge path - a second run form for the legacy shape
 * would be a second place for the priced gesture to drift.
 */
export function RunCustomAgentModal({
  agent,
  clientId,
  clients,
  contextItems,
  viewerIsClient,
  setup,
  initialPane,
  stayOnPage,
  onClose,
}: {
  agent: RunnableAgentSummary;
  /** Fixed client (client-page flow) … */
  clientId?: string;
  /** … or a picker (staff hub flow). */
  clients?: Array<{ id: string; name: string }>;
  contextItems: ContextItem[];
  viewerIsClient: boolean;
  /**
   * This agent's intake readiness, resolved server-side for this exact agent.
   * Carries the data form when the page prefetched it (collected inline), and
   * always carries the href to the agent's own data page (the way out when it
   * did not).
   */
  setup?: AgentSetupState;
  /** "data" opens straight on the agent's data; so does a missing company page. */
  initialPane?: RunPane;
  /**
   * Keep a STAFF run's confirmation here instead of navigating to /jobs/<id>
   * (AF-9).
   *
   * Albert on the post-run gesture: "when you click after run the agent, then it
   * goes back to…". This dialog is only ever mounted from an agent's own detail
   * page — the legacy panel and the Control Room's staff controls, which is the
   * whole list — so for staff the successful press replaced the page they were
   * reading with the raw job record, and every other thing they had open on that
   * agent (the Control Room tab, the schedule, the outputs) was gone. The run
   * itself is announced on the page they were already on: `running` on the status
   * strip covers it now, and AutoRefresh polls it to completion.
   *
   * The job is not hidden — the confirmation links it. What changes is that
   * following the link is a decision rather than a redirect.
   */
  stayOnPage?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedClientId, setSelectedClientId] = useState(clientId ?? clients?.[0]?.id ?? "");
  // "Post as" is the one field whose options are this client's own records
  // rather than a fixed list, so the profile is specialized before anything
  // renders or seeds from it. A no-op for every other agent: the helper returns
  // the profile untouched when it carries no identity field.
  const profile =
    setup?.kind === "linkedin"
      ? withLinkedInIdentityOptions(launchProfileFor(agent), setup.data.seats)
      : launchProfileFor(agent);
  const [fields, setFields] = useState<Record<string, string>>(() => initialAgentBrief(profile));
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  // Has anyone put work into the brief that a stray click would throw away?
  const [briefTouched, setBriefTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  /** The run this press produced, so a staff confirmation can link it (AF-9). */
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const intake = intakeFor(setup);
  const intakeReady = intake?.setup.ready ?? true;
  // The data opens on the company page being missing, not on the server gate:
  // `ready` is satisfied by a shared seat, so an X run would otherwise skip
  // straight to the brief for a client who set LinkedIn up first. This only
  // chooses the pane - `ready` alone still decides what a run does.
  // …or when the agent's one-time stand-up run has not happened. Pressing Run on
  // a LinkedIn agent that has never been set up would otherwise show a brief,
  // take the press, and refuse — so the press lands on the step that unblocks it.
  const openOnData =
    Boolean(intake) &&
    (!companyOnFile(intake) || !standUpDone(intake!) || initialPane === "data");
  const [pane, setPane] = useState<RunPane>(openOnData ? "data" : "run");
  // Did the data open because the run wanted it, rather than because someone
  // asked for it from the card? Held in state so it survives the props refresh
  // that saving the company page triggers underneath this dialog.
  const [openedForSetup] = useState(() => openOnData && initialPane !== "data");
  // Only someone who has seen the brief can go "back" to it. A dialog that
  // opened on the data has not shown it yet, so its way out reads forward.
  const [seenRun, setSeenRun] = useState(!openOnData);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dataPaneRef = useRef<HTMLDivElement>(null);
  const runPaneRef = useRef<HTMLDivElement>(null);
  const shownPane = useRef<RunPane>(pane);
  // `visibleFields` everywhere a field is PAINTED or offered for typing; the
  // full list keeps serving everything that reads VALUES (defaults seeded by
  // initialAgentBrief, batchSizeFrom, the missing-required check). A hidden
  // field must never be the primary field — quick-start chips write into the
  // primary, and text landing in an invisible box is text the client cannot
  // see or undo.
  const visibleFields = profile.fields.filter((field) => !field.hidden);
  const primaryField =
    visibleFields.find((field) => field.key === "request") ??
    visibleFields.find((field) => field.required) ??
    visibleFields[0] ??
    profile.fields[0];
  // The values a batch size may be read from: VISIBLE fields only. A hidden
  // batch_size is a UI removal, never a silent price change (see the field's
  // doc in custom-agent-launch.ts) — so neither the footer's quote nor the
  // submitted charge multiplier may see it. Derived from the same
  // `visibleFields` the form paints, so the two cannot drift.
  const visibleBriefValues = Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      visibleFields.some((field) => field.key === key),
    ),
  );
  // A server-side setup gate can still fire when this dialog's `ready` was
  // stale, so the message needs its own way back to the data.
  const setupErrorKind: IntakeKind | null = !error
    ? null
    : error.startsWith(X_SETUP_REQUIRED_PREFIX)
      ? "x"
      : error.startsWith(LINKEDIN_SETUP_REQUIRED_PREFIX)
        ? "linkedin"
        : error.startsWith(REDDIT_SETUP_REQUIRED_PREFIX)
          ? "reddit"
          : error.startsWith(NEWSLETTER_SETUP_REQUIRED_PREFIX)
            ? "newsletter"
            : error.startsWith(BLOG_SETUP_REQUIRED_PREFIX)
              ? "blog"
              : error.startsWith(REPUTATION_SETUP_REQUIRED_PREFIX)
                ? "reputation"
                : error.startsWith(CAROUSEL_SETUP_REQUIRED_PREFIX)
                  ? "carousel"
                  : null;

  // Both panes share the dialog's single scroll box, which also holds the title
  // and the sentence explaining the swap, so a switch has to go back to the top
  // of that box rather than to the top of the pane. The control that did the
  // switching lived in the pane it hid, so focus has to move too. Neither is
  // wanted on first mount - the dialog already opens at the top.
  useEffect(() => {
    if (shownPane.current === pane) return;
    shownPane.current = pane;
    (pane === "data" ? dataPaneRef : runPaneRef).current?.focus({ preventScroll: true });
    scrollRef.current?.scrollTo({ top: 0 });
  }, [pane]);

  function setField(key: string, value: string) {
    // "+ Add a seat" (portal revamp, Surface 04) is never a real identity —
    // it is the one option in this field that means "leave and set one up",
    // so it routes to the agent's own data page instead of becoming the run's
    // brief value. `setup.href` is the same link the data pane's own "manage"
    // affordance already uses.
    if (key === LINKEDIN_IDENTITY_FIELD_KEY && value === ADD_SEAT_OPTION_VALUE) {
      if (setup?.href) router.push(setup.href);
      return;
    }
    setBriefTouched(true);
    setFields((current) => ({ ...current, [key]: value }));
  }

  function showRun() {
    setSeenRun(true);
    setPane("run");
  }

  function submit() {
    setError(null);
    if (!selectedClientId) {
      setError("Pick a client. Agents always run against a client's context.");
      return;
    }
    const missing = profile.fields.find((field) => field.required && !fields[field.key]?.trim());
    if (missing) {
      setError(`${missing.label} is required.`);
      return;
    }
    const attachmentAlternative = profile.attachments.satisfyWithFieldKey;
    if (
      profile.attachments.required &&
      selectedFiles.length === 0 &&
      !(attachmentAlternative && fields[attachmentAlternative]?.trim())
    ) {
      setError(`Add ${profile.attachments.label.toLowerCase()} or provide the source link above.`);
      return;
    }
    // An agent whose only field is labelled "Optional" must be runnable with the
    // form left exactly as instructed - that is the run the intake-driven
    // agents are documented to support, and they draft from their stored data
    // either way. The brief joins non-empty fields only, so an untouched form
    // produced an empty prompt and a refusal naming a requirement that does not
    // exist. Fall back to the first starting point: the same text the chips
    // above insert, so the run is identical to clicking one.
    let prompt = buildCustomAgentPrompt(profile, fields);
    if (!prompt && !profile.fields.some((field) => field.required) && profile.quickStarts[0]) {
      prompt = buildCustomAgentPrompt(profile, {
        ...fields,
        [primaryField.key]: profile.quickStarts[0],
      });
    }
    if (!prompt) {
      setError("Add at least one line to the brief before starting the run.");
      return;
    }
    if (prompt.length > 4000) {
      setError(`This brief is ${prompt.length.toLocaleString()} characters. Shorten it to 4,000 characters.`);
      return;
    }
    startTransition(async () => {
      const result = await runCustomAgentAction({
        agentId: agent.id,
        clientId: selectedClientId,
        prompt,
        contextItemIds: selectedFiles,
        ...(batchSizeFrom(visibleBriefValues)
          ? { chargeMultiplier: batchSizeFrom(visibleBriefValues) }
          : {}),
        // The whole brief, for the fields the server reads as data rather than
        // as prose (the LinkedIn writer's "Post as"). The prompt above is built
        // for the agent to read; recovering an identity from it would mean
        // parsing our own copy, which breaks the next time someone edits a label.
        briefValues: fields,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (viewerIsClient || stayOnPage) {
        // The page behind this dialog is the one that narrates the run now, so
        // the refresh is what makes it start doing so — the in-flight mark and
        // the poller both key off a job that only exists after this await.
        if (result.jobId) setStartedJobId(result.jobId);
        setStarted(true);
        router.refresh();
      } else if (result.jobId) {
        router.push(`/jobs/${result.jobId}`);
      }
    });
  }

  if (started) {
    return (
      <Modal open onClose={onClose} title={agent.name}>
        <div className="mt-4 space-y-3 text-center">
          <Icon name="CircleCheck" className="mx-auto h-8 w-8 text-success" />
          <p className="text-sm text-foreground">Run started</p>
          {/* Drafts no longer reach the client archive at all: F149 filters it
              to approved, non-future items. phase3-design §3's sentence is for
              run-FINISHED surfaces; this one fires the moment a run starts, so
              it takes the future-tense "reviews it when it lands" form —
              nobody is reviewing anything yet.

              STAFF GET THEIR OWN SENTENCE (AF-9). This card is what a staff
              member now sees instead of being redirected, and the client's line
              tells the reader their Karos team will review it — which, to the
              Karos team, is a machine telling them to wait for themselves. */}
          <p className="text-xs text-muted">
            {viewerIsClient ? (
              <>
                The agent is working. This usually takes {profile.estimate.replace("~", "")}. Your
                Karos team reviews it when it lands, and finished posts appear in your Workspace
                once approved.
              </>
            ) : (
              <>
                The agent is working. This usually takes {profile.estimate.replace("~", "")}. This
                page keeps itself up to date while it runs, and the deliverables land in the review
                queue.
              </>
            )}
          </p>
          {/* Where the redirect used to go, as a choice. Staff only: /jobs is
              not a route a CLIENT_USER may open. */}
          {!viewerIsClient && startedJobId && (
            <Link
              href={`/jobs/${startedJobId}`}
              className="inline-flex items-center gap-1 text-xs text-neon hover:underline"
            >
              Open the run <Icon name="ArrowRight" className="h-3 w-3" />
            </Link>
          )}
          <Button variant="subtle" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  // One gate for every intake-driven agent whose form this dialog does NOT
  // carry. `setup` is already this agent's own answer, so the modal never
  // re-derives readiness from the agent key. When the page DID prefetch the
  // form (`intake`), the pane below collects it in place instead - a link out
  // would throw away the run the reader was setting up (ruling 7).
  //
  // IT NAMES THE FORM AND NOTHING ELSE (#113). It used to describe the shape of
  // the intake — "the company page, a seat per person, and the ongoing drops" —
  // which is the X and LinkedIn shape and wrong for the third agent it serves:
  // Reddit's intake is one account plus how mentions are handled (INTAKE_ASKS
  // holds all three, per kind). This branch cannot use that table, and the
  // reason is its own condition: `intake` is null exactly when `setup.kind` is
  // absent, so the one thing it does not know is WHICH agent it is looking at.
  // `label` and `href` it does know — the caller resolved both per agent — so
  // the copy is built from those and makes no claim about the form's contents.
  //
  // A BACKSTOP, NOT A ROUTE, and worth stating because it reads like a route.
  // No mount can reach it today: the agent library passes no `setup`;
  // StaffAgentControls is staff-only and the detail route prefetches the panes
  // for staff, so its `setup` always carries a kind; and LegacyAgentPanel — the
  // one mount a CLIENT reaches — is handed `evaluateLegacyRunGate`'s verdict,
  // which refuses on `setup_missing` and disables "Create a new post" with the
  // reason painted and the form linked. Making this reachable would mean
  // loosening that gate, which is correct as it stands, so it stays a backstop:
  // if a future mount does skip the gate, the reader meets a true sentence and a
  // way out rather than the submit core's refusal after writing a brief.
  if (setup && !setup.ready && !intake) {
    return (
      <Modal open onClose={onClose} title={agent.name}>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-foreground">Set up the {setup.label} first.</p>
          <p className="text-xs leading-relaxed text-muted">
            This agent drafts from what is saved on the {setup.label} page, and it will not
            run until that is there. It takes a few minutes to fill in, once.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <a
              href={setup.href}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
            >
              Set up {setup.label}
              <Icon name="ArrowRight" className="h-3.5 w-3.5" />
            </a>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const showData = Boolean(intake) && pane === "data";
  // Lead the eye on once the setup that held up a run is done; anyone who came
  // to read or edit data they already have gets the quiet version.
  const continueToRun = openedForSetup && companyOnFile(intake);

  return (
    // The blurb goes in the body, not Modal's `description`: that slot is an
    // unclamped <p>, so a long fallback manifest pushed the whole brief below
    // the fold. Same clamp + "More" as the card. It is also never
    // `agent.description` - that is the lab manifest, written for the people
    // who build agents, and this dialog is a client surface (CD-G2). The
    // estimate + Start run row is the pinned footer: on the long agent briefs
    // it used to scroll out of sight in the same box as the title.
    <Modal
      open
      onClose={onClose}
      title={showData && intake ? `${INTAKE_LABEL[intake.kind]} agent data` : agent.name}
      {...(showData
        ? {
            description: companyOnFile(intake)
              ? "This is what the agent drafts from. Change or add anything; it applies to the next run."
              : `We draft from this, so we ask for it before the first run: ${intake ? INTAKE_ASKS[intake.kind] : ""}.`,
          }
        : {})}
      className={showData ? "max-w-3xl" : "max-w-2xl"}
      // Both panes hold work a mis-click must not throw away: the intake form
      // in one, the brief in the other. Escape, the close button and the pane's
      // own dismiss stay the deliberate ways out.
      closeOnBackdrop={!intake && !briefTouched}
      scrollRef={scrollRef}
      // The data pane carries its own dismiss row; pinning "Start run" under it
      // would offer the run from the form that has to be saved first.
      {...(showData
        ? {}
        : {
            footer: (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-2">
                  <Icon name="Clock" className="mr-1 inline h-3 w-3" />
                  {profile.estimate}. You can leave this page; the run continues.
                  {viewerIsClient && (
                    /* × the VISIBLE batch size, because that is exactly what
                       the submit above sends as the charge multiplier — a
                       client picking 3 LinkedIn posts reads the tripled price
                       here, and a hidden size (the X profile) multiplies
                       nothing, so this quotes the flat per-run price. This
                       line used to quote the per-output base regardless of
                       the selector, understating a multi-output pick. */
                    <span className="ml-1">
                      Costs{" "}
                      {creditsLabel(
                        agentRunCost(agent) * (batchSizeFrom(visibleBriefValues) ?? 1),
                      )}
                      .
                    </span>
                  )}
                </p>
                <Button variant="accent" onClick={submit} loading={pending}>
                  {pending ? "Starting…" : "Start run"}
                </Button>
              </div>
            ),
          })}
    >
      {intake && (
        // Both panes stay mounted. Every field in the intake cards is local
        // state, so unmounting the form to show the brief would discard typed
        // text; `hidden` keeps the idle pane out of the tab order and the
        // accessibility tree too. Each pane takes focus when it is shown, so it
        // needs to be focusable without drawing a ring of its own.
        <div
          ref={dataPaneRef}
          tabIndex={-1}
          className="space-y-5 focus:outline-none"
          hidden={!showData}
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* The way on stays in place while the setup is unfinished so that
                saving the company page changes only its tone, never the layout
                under the reader's hands. */}
            <Button
              size="sm"
              variant={continueToRun ? "accent" : "subtle"}
              disabled={!intakeReady}
              onClick={showRun}
            >
              {seenRun ? (
                <>
                  <Icon name="ArrowLeft" className="h-3.5 w-3.5" /> Back to the run
                </>
              ) : (
                <>
                  Continue to the run
                  <Icon name="ArrowRight" className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
            {!intakeReady && intake && (
              <p className="text-xs text-muted">{INTAKE_FIRST_STEP[intake.kind]}</p>
            )}
          </div>
          <IntakeForm intake={intake} />
          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button variant="ghost" onClick={onClose}>
              {openedForSetup ? "Cancel run" : "Close"}
            </Button>
          </div>
        </div>
      )}

      <div
        ref={runPaneRef}
        tabIndex={-1}
        className="space-y-5 focus:outline-none"
        hidden={showData}
      >
        <AgentBlurb text={agentBlurb(agent)} />
        {intake && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Reaching the brief at all means the company page is on file, so
                in practice this reads quiet. It still asks, because the flag it
                asks about belongs to the caller and the tone must not lie if
                that flag ever parts company with the rows shipped beside it. */}
            <AgentDataButton
              kind={intake.kind}
              ready={intakeComplete(intake)}
              onOpen={() => setPane("data")}
            />
          </div>
        )}

        <div className="rounded-md border border-border bg-surface-2 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-lg">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-2">{profile.eyebrow}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{profile.intro}</p>
            </div>
            <Badge tone="neutral">
              <Icon name="Clock" className="h-3 w-3" /> {profile.estimate}
            </Badge>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {profile.deliverables.map((deliverable) => (
              <span key={deliverable} className="inline-flex items-center gap-1.5 text-[11px] text-foreground">
                <Icon name="Check" className="h-3 w-3 text-success" /> {deliverable}
              </span>
            ))}
          </div>
        </div>

        {!clientId && clients && (
          <div>
            <Label htmlFor="ca-client">Client</Label>
            {clients.length === 1 ? (
              // F38. A per-client agent instance has exactly one client it can
              // draft for, and a dropdown of one is a question with a single
              // answer - worse, it reads as though there were a choice. The
              // fixed chip states the binding instead.
              <div
                id="ca-client"
                className="mt-1 inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground"
              >
                <Icon name="Building2" className="h-3.5 w-3.5 text-muted-2" />
                {clients[0].name}
                {perClientAgentSlug(agent.key) ? (
                  <span className="text-muted-2">· this agent&apos;s own client</span>
                ) : null}
              </div>
            ) : (
              <Select
                id="ca-client"
                value={selectedClientId}
                onChange={(event) => {
                  setSelectedClientId(event.target.value);
                  setSelectedFiles([]);
                }}
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )}

        <div>
          <Label>Common starting points</Label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {profile.quickStarts.map((quickStart) => (
              <button
                key={quickStart}
                type="button"
                onClick={() => setField(primaryField.key, quickStart)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-left text-[11px] transition-colors",
                  fields[primaryField.key] === quickStart
                    ? "border-neon/60 bg-neon/10 text-neon"
                    : "border-border bg-surface-2 text-muted hover:border-border-strong hover:text-foreground",
                )}
              >
                {quickStart}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {visibleFields.map((field) => {
            const id = `ca-${agent.id}-${field.key}`;
            const fullWidth = field.type === "textarea";
            return (
              <div key={field.key} className={fullWidth ? "sm:col-span-2" : undefined}>
                <Label htmlFor={id}>
                  {field.label}
                  {field.required ? <span className="ml-1 text-danger">*</span> : null}
                </Label>
                {field.type === "select" ? (
                  <Select
                    id={id}
                    value={fields[field.key] ?? ""}
                    onChange={(event) => setField(field.key, event.target.value)}
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                ) : field.type === "textarea" ? (
                  <Textarea
                    id={id}
                    rows={3}
                    maxLength={1600}
                    placeholder={field.placeholder}
                    value={fields[field.key] ?? ""}
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                ) : (
                  <Input
                    id={id}
                    type={field.type === "number" ? "number" : "text"}
                    min={field.min}
                    max={field.max}
                    maxLength={field.type === "number" ? undefined : 500}
                    placeholder={field.placeholder}
                    value={fields[field.key] ?? ""}
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                )}
                {field.helper ? <p className="mt-1 text-xs text-muted-2">{field.helper}</p> : null}
              </div>
            );
          })}
        </div>

        <AgentInputFiles
          key={`${selectedClientId}-${agent.id}`}
          clientId={selectedClientId}
          agentName={agent.name}
          items={contextItems}
          selectedIds={selectedFiles}
          onChange={(ids) => {
            setBriefTouched(true);
            setSelectedFiles(ids);
          }}
          profile={profile.attachments}
          canUpload={!viewerIsClient}
        />

        {error && (
          <p className="text-xs text-danger" role="alert">
            {error}
            {setupErrorKind &&
              (intake ? (
                <button
                  type="button"
                  onClick={() => setPane("data")}
                  className="ml-1.5 cursor-pointer underline"
                >
                  Open {INTAKE_LABEL[setupErrorKind]} agent data →
                </button>
              ) : (
                selectedClientId && (
                  <a
                    href={`/clients/${selectedClientId}/${INTAKE_ROUTE[setupErrorKind]}`}
                    className="ml-1.5 underline"
                  >
                    Open {INTAKE_LABEL[setupErrorKind]} agent data →
                  </a>
                )
              ))}
          </p>
        )}

      </div>
    </Modal>
  );
}

/* ═══════════════════════ editor (admin) ═══════════════════════ */

function AgentEditorModal({ agent, onClose }: { agent: CustomAgent | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [name, setName] = useState(agent?.name ?? "");
  const [key, setKey] = useState(agent?.key ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [clientBlurb, setClientBlurb] = useState(agent?.clientBlurb ?? "");
  const [icon, setIcon] = useState(agent?.icon ?? "Sparkles");
  const [color, setColor] = useState(agent?.color ?? "#A3E635");
  const [entrySkillDir, setEntrySkillDir] = useState(agent?.entrySkillDir ?? "");
  const [skillRoots, setSkillRoots] = useState((agent?.skillRoots ?? []).join("\n"));
  const [includeClientSkills, setIncludeClientSkills] = useState(agent?.includeClientSkills ?? true);
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [creditCost, setCreditCost] = useState(agent?.creditCost != null ? String(agent.creditCost) : "");
  const [launchCreditCost, setLaunchCreditCost] = useState(
    agent?.launchCreditCost != null ? String(agent.launchCreditCost) : "",
  );
  const [stepModelsText, setStepModelsText] = useState(
    Object.entries(agent?.stepModels ?? {})
      .map(([step, model]) => `${step}: ${model}`)
      .join("\n"),
  );
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);

  function parseStepModels(raw: string): Record<string, string> | null {
    const entries: Array<[string, string]> = [];
    for (const line of raw.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const step = line.slice(0, idx).trim();
      const model = line.slice(idx + 1).trim();
      if (step && model) entries.push([step, model]);
    }
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  }

  function save() {
    setError(null);
    const input = {
      name,
      key: key || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      description,
      clientBlurb,
      icon,
      color,
      entrySkillDir,
      skillRoots: skillRoots.split("\n").map((s) => s.trim()).filter(Boolean),
      includeClientSkills,
      instructions,
      creditCost: creditCost.trim() === "" ? null : Number(creditCost),
      launchCreditCost: launchCreditCost.trim() === "" ? null : Number(launchCreditCost),
      stepModels: parseStepModels(stepModelsText),
      enabled,
    };
    startTransition(async () => {
      const result = agent
        ? await updateCustomAgentAction(agent.id, input)
        : await createCustomAgentAction(input);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteCustomAgentAction(agent!.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={agent ? `Edit ${agent.name}` : "New custom agent"}
      description="The instructions are the agent's system prompt. The run adds the client context and the user's request around them."
      className="max-w-2xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          {agent ? (
            confirmDelete ? (
              <span className="flex items-center gap-2 text-xs">
                Delete this agent?
                <Button size="sm" variant="danger" onClick={remove} loading={pending}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                <Icon name="Trash2" className="h-3.5 w-3.5" /> Delete
              </Button>
            )
          ) : (
            <span />
          )}
          <Button variant="accent" onClick={save} loading={pending}>
            {agent ? "Save changes" : "Create agent"}
          </Button>
        </div>
      }
    >
      <div className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="ae-name">Name</Label>
            <Input id="ae-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Instagram Agent" />
          </div>
          <div>
            <Label htmlFor="ae-key">Key</Label>
            <Input id="ae-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="karos-instagram-agent" />
          </div>
        </div>
        <div>
          <Label htmlFor="ae-desc">Description (internal)</Label>
          <Textarea id="ae-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          <p className="mt-1 text-xs text-muted-2">
            The lab manifest blurb. Staff surfaces only. Clients never see this.
          </p>
        </div>
        <div>
          <Label htmlFor="ae-blurb">Client blurb</Label>
          <Textarea
            id="ae-blurb"
            rows={2}
            maxLength={300}
            value={clientBlurb}
            onChange={(e) => setClientBlurb(e.target.value)}
            placeholder="Drafts a week of on-brand posts for your team to review and publish."
          />
          <p className="mt-1 text-xs text-muted-2">
            What the client reads on the agent card and in the run dialog: 1–2 sentences, sentence
            case, no product codes. Leave it empty and every client surface reads a generic keyed
            line instead. The internal description above never reaches them.
          </p>
        </div>
        <div>
          <Label htmlFor="ae-entry">Entry skill dir (in karos-agents)</Label>
          <Input
            id="ae-entry"
            value={entrySkillDir}
            onChange={(e) => setEntrySkillDir(e.target.value)}
            placeholder="products/live/instagram-agent"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label htmlFor="ae-roots">Extra skill roots (one per line, optional)</Label>
          <Textarea
            id="ae-roots"
            rows={2}
            value={skillRoots}
            onChange={(e) => setSkillRoots(e.target.value)}
            placeholder="skills/vendors/taste-skill"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label htmlFor="ae-instructions">Instructions (system prompt)</Label>
          <Textarea
            id="ae-instructions"
            rows={8}
            maxLength={12000}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="font-mono text-xs"
          />
          <p className="mt-1 text-right text-xs text-muted-2">{instructions.length.toLocaleString()} / 12,000</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="ae-icon">Icon (lucide name)</Label>
            <Input id="ae-icon" value={icon} onChange={(e) => setIcon(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ae-color">Color</Label>
            <Input id="ae-color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="#A3E635" />
          </div>
          <div>
            <Label htmlFor="ae-cost">Credits per run</Label>
            <Input
              id="ae-cost"
              type="number"
              min={0}
              value={creditCost}
              onChange={(e) => setCreditCost(e.target.value)}
              placeholder={`${CREDIT_COSTS.customAgentRun} (default)`}
            />
            <p className="mt-1 text-xs text-muted-2">
              What this agent charges a client per run, on its card and in the run dialog. Left
              empty every agent prices the same, and a video edit costs what a single post does.
            </p>
          </div>
        </div>
        {/* §6.3. Until this is set the client's self-serve Launch button stays
            disabled with a visible "pricing is being finalized" reason - gated
            rather than provisional, because billing an invented number that
            later changes is the F130 placeholder-pricing failure at the most
            expensive SKU. Staff launches stay free and ARE the measurement runs;
            the economics card on the client's agents page surfaces the measured
            ratio and a suggested price to type in here. */}
        <div className="sm:max-w-xs">
          <Label htmlFor="ae-launch-cost">Credits for setup (one time)</Label>
          <Input
            id="ae-launch-cost"
            type="number"
            min={0}
            value={launchCreditCost}
            onChange={(e) => setLaunchCreditCost(e.target.value)}
            placeholder="not priced yet"
          />
          <p className="mt-1 text-xs text-muted-2">
            The one-off setup run that researches the brand and designs the template set. Must be
            higher than the per-run price. Left empty, clients cannot launch this agent themselves
            and staff run the setup for them.
          </p>
        </div>
        <div>
          <Label htmlFor="ae-step-models">Per-step model overrides (one per line, optional)</Label>
          <Textarea
            id="ae-step-models"
            rows={3}
            value={stepModelsText}
            onChange={(e) => setStepModelsText(e.target.value)}
            placeholder={"draft-post: claude-haiku-4-5\nresearch: claude-opus-4-8"}
            className="font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-2">
            `step name: model id`, one per line. Only takes effect for a skill whose steps are
            named subagents matching these names, and is a no-op otherwise. Leave empty to run the whole
            job on the task type&apos;s single default model, as today.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-neon" />
            Enabled
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs" title="Also load the client's emitted sub-skills (clients/<slug>/skills/)">
            <input
              type="checkbox"
              checked={includeClientSkills}
              onChange={(e) => setIncludeClientSkills(e.target.checked)}
              className="accent-neon"
            />
            Use client&apos;s emitted skills
          </label>
        </div>

        {agent?.source?.status === "blocked" && (
          <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
            <Icon name="TriangleAlert" className="mr-1 inline h-3.5 w-3.5 text-warning" />
            The repo catalog marks this skill blocked. Review before enabling.
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

export function ClientAgentAccessCard({
  clientId,
  agents,
  allowedIds,
}: {
  clientId: string;
  agents: CustomAgent[];
  allowedIds: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Intersect with the current library: an allowlist can reference agents that
  // were deleted since it was saved, and those must not block re-saving.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(allowedIds.filter((id) => agents.some((a) => a.id === id))),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = useMemo(() => {
    if (selected.size !== allowedIds.length) return true;
    return allowedIds.some((id) => !selected.has(id));
  }, [selected, allowedIds]);

  function toggle(id: string) {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await setClientCustomAgentsAction(clientId, [...selected]);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  if (agents.length === 0) {
    return (
      <p className="text-xs text-muted">
        No custom agents in the library yet. Import them on the{" "}
        <Link href="/agents" className="text-neon hover:underline">
          Agents page
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        {agents.map((agent) => (
          <label
            key={agent.id}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-surface-2",
              !agent.enabled && "opacity-60",
            )}
          >
            <input
              type="checkbox"
              checked={selected.has(agent.id)}
              onChange={() => toggle(agent.id)}
              className="accent-neon"
            />
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/80">
              <AgentMark identity={`${agent.key} ${agent.name}`} icon={agent.icon} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground">{agent.name}</span>
            <span className="shrink-0 text-muted-2">
              {agentRunCost(agent) * defaultRunBatchSize({ key: agent.key, name: agent.name })} cr/run
            </span>
            {!agent.enabled && <Badge tone="warning">Disabled</Badge>}
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-2">
          {saved ? "Saved." : "Checked agents appear on the client's AI agents page, billed per run."}
        </p>
        <Button size="sm" variant="accent" onClick={save} loading={pending} disabled={!dirty}>
          Save access
        </Button>
      </div>
    </div>
  );
}
