import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, requireVisibleClient } from "@/lib/auth";
import { adminAuth } from "@/lib/firebase/admin";
import {
  getClientCredits,
  getClientSeoGeo,
  listAssets,
  listClientIntegrations,
  listCreditLedger,
  listCustomAgents,
  listJobs,
  listPlannedScheduledRuns,
  listScheduledRuns,
  listTranscripts,
  getClientSettings,
  listClientContextDocs,
  listClientCompetitors,
  listClientActionStates,
} from "@/lib/data";
import { listClientAgents } from "@/lib/data-client-agents";
import { getOAuthEnabledPlatforms, googleBusinessProfileRequested } from "@/lib/integrations/oauth";
import { sanitizeIntegrations, sanitizeLinkedinSeats } from "@/lib/integrations/sanitize";
import {
  CREDIT_COSTS,
  DEFAULT_LINKEDIN_SEAT_LIMIT,
  availableCredits,
  creditBlockReason,
  isBillableClientActor,
} from "@/lib/credits";
import {
  redactLedgerForClient,
  spendAgentNames,
  summarizeClientMonthlyCost,
  summarizeClientSpend,
} from "@/lib/credit-reporting";
import { MONTHLY_ALLOWANCE, isCreditsPlanV2Enabled } from "@/lib/credits";
import { computeTrackedCompetitors } from "@/lib/competitor-priority";
import { SeoGeoPanel, SeoGeoScores } from "@/components/seo-geo-panel";
import { ClientSuggestions } from "@/components/seo-geo/client-suggestions";
import { VisibilityWork, type VisibilityWorkRow } from "@/components/seo-geo/visibility-work";
import { buildClientRosterEntries } from "@/lib/client-roster";
import type { RosterStatus } from "@/lib/client-agents";
import {
  citationDomainFor,
  sortVisibilityWorkRows,
  visibilityLeverFamilies,
  visibilityLeverFor,
} from "@/lib/visibility-levers";

/**
 * The three action-list rows the document foot can write, keyed by id (round 6,
 * decision 3). The inverse of `ACTION_ID_BY_DOC_TYPE` in
 * `components/client-documents.tsx`, which is where the press writes them;
 * this page only reads them back so the foot knows what has been answered.
 */
const CONFIRMABLE_DOC_TYPE_BY_ACTION_ID: Record<string, ContextDocType | undefined> = {
  "21": "brand-voice",
  "22": "target-audience",
  "23": "competitor-analysis",
};

/** Rows the "Recent activity" feed shows. */
const LEDGER_FEED_LIMIT = 15;
/** Rows the Meetings card shows before "See all N meetings" takes over. */
const MEETING_ROWS = 12;
import { Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import AutoScheduleToggle from "@/components/auto-schedule-toggle";
import { Icon } from "@/components/icon";
import { IntegrationsTab } from "@/components/integrations-tab";
import { ClientKeyInline } from "@/components/client-key-inline";
import { CreditsPanel } from "@/components/credits-panel";
import { ClientAgentAccessCard } from "@/components/custom-agents";
import { ScheduledRunsCard } from "@/components/scheduled-runs";
import { ClientEditor } from "@/components/client-editor";
import { StaffOnlySection } from "@/components/staff-only-section";
import { ClientProfilePanel } from "@/components/client-profile-panel";
import { ClientDocuments } from "@/components/client-documents";
import { CompetitorTrack, BrandColorsSection } from "@/components/client-context-sections";
import { clientIntelSchedule } from "@/lib/intel-schedule";
import { isAiProcessingLockActive } from "@/lib/constants";
import { hasAiProcessingFailure, toClientPortalView } from "@/lib/client-visibility";
import { SettingsTabs, type SettingsTab } from "@/components/settings-tabs";
import { AccountProfilePanel, AccountSecurityPanel } from "@/components/settings-form";
import { ACCOUNT_TABS } from "@/lib/account-settings-tabs";
import { agentKeyMatchesClientSlug } from "@/lib/custom-agent-launch";
import { relativeTime } from "@/lib/utils";
import type {
  Asset,
  ClientIntegration,
  Transcript,
  ClientCredits,
  CreditLedgerEntry,
  CustomAgent,
  ClientAgent,
  ClientSettings,
  EmployeeSeat,
  Job,
  JobRunType,
  PlannedScheduledRun,
  ScheduledRun,
  ClientContextDoc,
  ClientCompetitor,
  ClientActionState,
  ContextDocType,
} from "@/lib/types";
import {
  buildClientSuggestions,
  categoryMetrics,
  rootDomain,
  type SeoGeoInsights,
} from "@/lib/seo-geo";

export default async function ClientSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // Read here rather than with useSearchParams in SettingsTabs: this keeps the
  // tab component free of a Suspense requirement and seeds it from the URL on a
  // hard load, which is what makes a ?tab= link work at all.
  //
  // `status` no longer seeds anything ON THIS PAGE — it survives only as the
  // second half of the `?tab=archive&status=…` deep link this page used to
  // hold, forwarded to the calendar below (portal feedback round 2, 2026-09).
  searchParams: Promise<{ tab?: string; status?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { tab: initialTab, status: statusParam } = await searchParams;

  if (user.role === "CLIENT_USER") {
    if (user.clientId !== id) redirect(user.clientId ? `/clients/${user.clientId}` : "/assets");
  } else if (user.role !== "KAROS_ADMIN" && user.role !== "KAROS_EMPLOYEE") {
    redirect("/dashboard");
  }

  /**
   * THE TWO TABS THIS PAGE GAVE UP (portal feedback round 2, 2026-09).
   *
   * "Archive does not need to be in settings, it's in the calendar. Meetings
   * can be a sub-section in, like, account settings." Both tabs are gone from
   * the strip — Archive to the calendar's own archive view, Meetings down into
   * the Settings tab — and every producer of the old URLs has been re-pointed
   * (action-list, agent-intake-links, content-status-links, the copilot's
   * archive link). This block is for the links that are already in histories,
   * bookmarks and sent emails, which no re-point can reach.
   *
   * Answered HERE, before anything renders, rather than by keeping an empty tab
   * that says where the content went: a deep link that lands on the content is
   * worth more than one that lands on an apology.
   */
  if (initialTab === "archive") {
    const q = statusParam ? `&status=${encodeURIComponent(statusParam)}` : "";
    // A CLIENT_USER's calendar is the flat route (the scoped one bounces them
    // to it anyway); staff read this client's calendar at the scoped route,
    // because theirs is the cross-client overview, which has no one archive.
    redirect(
      user.role === "CLIENT_USER"
        ? `/calendar?view=archive${q}`
        : `/clients/${encodeURIComponent(id)}/calendar?view=archive${q}`,
    );
  }
  if (initialTab === "meetings") {
    // The hash is best-effort: browsers do honour a fragment on a Location
    // header, but a client-side RSC redirect may drop it — in which case this
    // still lands on the tab that HOLDS the meetings section, one scroll away.
    redirect(`/clients/${encodeURIComponent(id)}/settings?tab=settings#meetings`);
  }
  if (initialTab === "documents") {
    // THE THIRD TAB THIS PAGE GAVE UP (portal feedback round 4, 2026-09): "the
    // documents can live in Profile." Same treatment as the two above, and for
    // the same reason — the old id is in the onboarding checklist's own links,
    // in histories and in sent emails.
    redirect(`/clients/${encodeURIComponent(id)}/settings?tab=profile#documents`);
  }

  const client = await requireVisibleClient(user, id);

  const isAdmin = user.role === "KAROS_ADMIN";
  const isStaff = isAdmin || user.role === "KAROS_EMPLOYEE";
  const isClientViewer = user.role === "CLIENT_USER";
  /**
   * THE PAGE'S CLOCK, read once (round 6, alignment fix 5).
   *
   * `buildClientRosterEntries` took its own `Date.now()` where it was awaited,
   * which is a second clock on a page that derives statuses, windows and
   * relative times from data read in one wave — and two clocks on one render is
   * how two surfaces end up disagreeing about the same instant. The credits
   * card still takes its month from `credits.monthKey` rather than from here,
   * deliberately: see its own note.
   */
  // eslint-disable-next-line react-hooks/purity -- server component, no re-render concern
  const now = Date.now();
  const [
    integrations,
    transcripts,
    credits,
    creditLedger,
    customAgents,
    settings,
    scheduledRuns,
    contextDocs,
    competitors,
    plannedRuns,
    rosterAssets,
    seoGeo,
    actionStates,
    spendJobs,
    spendUmbrellas,
  ] = (await Promise.all([
    listClientIntegrations(id),
    // FILTERED FOR A CLIENT READER, the same way /transcripts filters its own
    // list (transcripts/page.tsx): a transcript marked `hiddenFromClient` is one
    // staff took off this client's record, and it must not be counted or listed
    // here either. It used to be read unfiltered, so the Meetings card rendered
    // hidden calls as rows — and, once that card gained a "See all N meetings"
    // link, quoted a total the client's own list could never reach.
    listTranscripts({ clientId: id, ...(isClientViewer ? { excludeHiddenFromClient: true } : {}) }),
    getClientCredits(id),
    // The WHOLE ledger, uncapped. The feed below slices it to 15, but the
    // per-agent breakdown (§6.2a) sums it, and "where your credits went"
    // computed from a capped slice is a breakdown of recent spend presented as
    // a breakdown of spend. The cap was 500 rows, which cost the same read as
    // no cap - listCreditLedger fetches every row regardless - and only ever
    // dropped the client's oldest agents off their own bill.
    listCreditLedger(id),
    // Read for EVERY role now, not just admins. The admin-only cards below are
    // still the only thing rendered from it, but the credits panel needs the
    // library to name the agent behind a charge: with only the client's jobs to
    // go on, an agent whose runs carry no `customAgentId` was billed to them as
    // "Removed agent" while it sat in the library, enabled and firing.
    listCustomAgents(),
    getClientSettings(id),
    isAdmin ? listScheduledRuns({ clientId: id }) : Promise.resolve([]),
    // Account Center Documents tab (portal revamp, Surface 06 — moved off the
    // rail). Client viewers get the client tier only, same boundary the rail
    // used to enforce; staff get every tier so ClientDocuments' own
    // allowInternalFallback has something to fall back to.
    listClientContextDocs(id, isClientViewer ? "client" : undefined),
    listClientCompetitors(id),
    // THE TWO READS THE REPORTING TAB'S AGENT SECTION ADDS (round 6, 2026-09).
    // "What we are doing to improve your SEO and GEO" names each agent with the
    // status word the roster gives it, and that derivation
    // (`buildClientRosterEntries`) needs the client's planned runs and their
    // assets. Both join this Promise.all rather than being awaited later, so
    // the section costs latency once rather than serially (ruling 8). The
    // page's other three inputs to it — the agent catalogue, the jobs and the
    // umbrellas — are already read below for the credits breakdown, so nothing
    // is read twice. The `listAssets` cost note on the agents page's own call
    // applies here too: unbounded per client, fine at pilot volume.
    listPlannedScheduledRuns({ clientId: id }),
    listAssets({ clientId: id }),
    getClientSeoGeo(id),
    // Which context documents this client has already told us look right
    // (round 6, decision 3 · handoffs/C.md). The document foot writes action
    // rows 21 / 22 / 23 on "Looks right", and without this read it would ask
    // the same question again on the next visit. Home reads the same
    // collection for the setup ladder; here it joins the page's existing
    // Promise.all rather than being awaited later (ruling 8).
    listClientActionStates(id),
    // THE CREDITS BREAKDOWN'S TWO READS, MOVED UP A WAVE (round 6, alignment
    // fix 5). They were a second serial `Promise.all` below, and the Reporting
    // tab's roster derivation — which needs both of them — was a THIRD serial
    // await after that. Nothing here depends on them, so they belong in the
    // first wave and the derivation moves into the second, which turns three
    // round trips into two (ruling 8).
    listJobs({ clientId: id }),
    listClientAgents({ clientId: id }),
  ])) as [
    ClientIntegration[],
    Transcript[],
    ClientCredits,
    CreditLedgerEntry[],
    CustomAgent[],
    ClientSettings | null,
    ScheduledRun[],
    ClientContextDoc[],
    ClientCompetitor[],
    PlannedScheduledRun[],
    Asset[],
    SeoGeoInsights | null,
    ClientActionState[],
    Job[],
    ClientAgent[],
  ];

  /**
   * The rows the Meetings card actually renders, cut here rather than in the
   * JSX (review wave, 2026-09) — and the cut is the cheap half of a fix.
   *
   * `listTranscripts` returns whole transcript documents, `rawText` and all, to
   * render twelve titles and dates: a year of calls is megabytes of transcript
   * body crossing Firestore, this server component and the RSC payload for a
   * card that shows a title, a date and a chevron. Only the SLICE is in hand
   * here; the read itself cannot be narrowed from this file.
   *
   * TODO(perf): give `listTranscripts` a projection —
   * `.select("title", "meetingDate", "createdAt", "clientId", "archived",
   * "hiddenFromClient")` behind an opt-in flag (`listTranscripts({ clientId,
   * fields: "summary" })`), and have this page and /transcripts' own list use
   * it. Both surfaces render row metadata only; `getTranscript` stays the one
   * caller that needs the body. Deliberately not done here: `src/lib/data.ts`
   * is the shared data layer and is owned by another change in flight.
   */
  const recentTranscripts = transcripts.slice(0, MEETING_ROWS);

  /**
   * WAVE TWO: what needs wave one's answers, and nothing else (round 6,
   * alignment fix 5).
   *
   *  · The viewer's own Firebase Auth record, for the account tabs at the end
   *    of this page. It depends on nothing above; awaited on its own further
   *    down it was a serial round trip to Firebase for no reason. Client
   *    viewers only, which is the only reader those tabs are built for.
   *  · The Reporting tab's roster entries — "What we are doing to improve your
   *    SEO and GEO" names each agent with the word the roster gives it, and
   *    `buildClientRosterEntries` needs five things wave one read plus this
   *    page's clock. It was a THIRD serial await, at the point of use, and it
   *    fires its own per-agent intake reads inside, so leaving it there put a
   *    whole read wave behind two that had already finished (ruling 8).
   *
   * The jobs and the umbrellas the credits breakdown reads moved INTO wave one
   * to make that possible: the derivation needs them, and nothing in wave one
   * did.
   */
  const [viewerAuthRecord, rosterEntries] = await Promise.all([
    isClientViewer ? adminAuth().getUser(user.uid) : Promise.resolve(null),
    buildClientRosterEntries({
      clientId: id,
      client,
      // The CLIENT scope for both readers, deliberately: the status word is the
      // client-facing one by ruling, so staff in client context read exactly
      // what the client reads rather than a staff-flavoured answer that could
      // disagree with it. (Since the review pass the scope cannot change the
      // word at all — see `lib/client-roster.ts` — so this now only says which
      // agents the section lists.)
      viewer: { role: user.role, seatId: user.seatId, isGroupAdmin: user.isGroupAdmin },
      // NO ROW FACTS (round 6 review, E11). This section prints a mark, a name,
      // a lever sentence and the status word. The newest deliverable and the
      // next planned day are a full attribution pass per agent for two values
      // nothing on this tab renders.
      withRowFacts: false,
      now,
      data: {
        allAgents: customAgents,
        jobs: spendJobs,
        plannedRuns,
        umbrellas: spendUmbrellas,
        assets: rosterAssets,
      },
    }),
  ]);
  const runTypeByJobId: Record<string, JobRunType | undefined> = {};
  for (const job of spendJobs) runTypeByJobId[job.id] = job.runType;
  const spendByAgent = summarizeClientSpend({
    ledger: creditLedger,
    runTypeByJobId,
    // All three sources, resolved by the one helper — the jobs alone left every
    // charge from an agent with no `customAgentId` on its runs unnamed, and the
    // umbrella rung is what stops this page printing a second name for an agent
    // the client already knows by their own (§7.3).
    agentNameById: spendAgentNames({
      customAgents,
      jobs: spendJobs,
      umbrellas: spendUmbrellas,
    }),
  });
  // What this client has actually cost Karos this month, for the staff-only
  // line on the credits card. STAFF ONLY AND GATED HERE, not in the panel:
  // CreditsPanel is a "use client" component, so a figure passed to it is in the
  // page payload whether or not it is painted. The same structural gate
  // agent-economics.tsx applies to the same class of number.
  //
  // Computed from `spendJobs` — already loaded above for the per-agent
  // breakdown, so this costs no extra read — and deliberately including failed
  // and staff-fired runs, which is the whole point: those are the dollars the
  // credit ledger cannot see. No `usageLogs` rows are passed: agent runs are the
  // dominant cost and querying a month of usage rows on every settings render
  // would not pay for the pennies of in-app model spend it would add.
  // Staff AND the rework switched on: with it off there is no settle-to-actual
  // model, so "of $130" would be measuring against a budget nothing enforces.
  const monthlyCost =
    isStaff && isCreditsPlanV2Enabled()
    ? summarizeClientMonthlyCost({
        jobs: spendJobs,
        // THE CREDITS DOC'S OWN WINDOW, not a fresh clock. The two lines on
        // the staff card are only comparable if they cover the same month, and
        // `getClientCredits` has already rolled this doc's windows on read — so
        // taking the key from it makes that true by construction rather than by
        // two clocks agreeing. (It is also the only pure option in a server
        // component: `Date.now()` during render is refused outright.)
        monthKey: credits.monthKey,
        monthlyAllowance: MONTHLY_ALLOWANCE,
      })
    : undefined;
  const oauthEnabledPlatforms = getOAuthEnabledPlatforms();

  // Both agent controls below act on THIS client, so neither may offer a
  // per-client agent instance belonging to another one: granting it would be
  // inert (both submit cores refuse the pair) and scheduling it would build a
  // row that refuses on every fire.
  const clientAgents = customAgents.filter((a) =>
    agentKeyMatchesClientSlug(a.key, client.agentsRepoSlug),
  );

  // Sanitized LinkedIn seats for the multi-seat workspace - strip tokens; the UI
  // never needs (and must never receive) the credentials, encrypted or not.
  const linkedIntegration = integrations.find((i) => i.platform === "linkedin") as ClientIntegration | undefined;
  const sanitizedLinkedinSeats = sanitizeLinkedinSeats(linkedIntegration?.employeeSeats as EmployeeSeat[] | undefined);

  // Same rule for the integrations themselves: the docs carry OAuth access/refresh
  // tokens and pasted API keys in `credentials`, so only the non-secret fields cross
  // - plus which secrets are set, for the form's placeholder.
  const sanitizedIntegrations = sanitizeIntegrations(integrations);

  // THE ASSET READ, AND WHY IT IS BACK (round 6, corrected in the review pass).
  //
  // Round 4 removed it: it had been narrowed to a client-visible library slice
  // for exactly one consumer, the Reporting tab's "Content by status" chart, and
  // Reporting stopped carrying Performance. Round 6 gave this page a NEW reason
  // to need it — `rosterAssets` in the first wave above — and the comment that
  // stood here still said there was no asset read, which is the opposite of the
  // truth two hundred lines further up.
  //
  // WHAT IT IS FOR NOW: "What we are doing to improve your SEO and GEO" names
  // each agent with the status word the roster gives it, and both halves of that
  // word need assets — the delivered-work join (a lab import has no job at all)
  // and the AF-5 upcoming-content rung. No projection or window is applied,
  // because `listAssets` offers neither: it is an unbounded `where clientId ==`
  // read with an in-process sort (data.ts), so the only cheaper shapes are a
  // `.select(...)` projection of the fields attribution and the archive filter
  // touch or a date-bounded query — both changes to the data layer, not to this
  // page, and both stated in full on the agents page's own call. It is read once
  // and joined into the page's existing first wave, and `withRowFacts: false`
  // keeps it from being walked for facts this tab never prints.

  // Price + refusal for a targeted document correction, for the Documents
  // tab's Correct Info modal — moved here from the app layout (portal revamp):
  // ClientDocuments no longer mounts on every page via the rail, so only the
  // one page that still mounts it needs to resolve this. Present only for a
  // billable client viewer; staff and admins in "View as Client" are never
  // charged, so they see no price.
  const correctionPricing = isBillableClientActor(user)
    ? {
        cost: CREDIT_COSTS.targetedCorrection,
        ...(availableCredits(credits) < CREDIT_COSTS.targetedCorrection
          ? { blockReason: creditBlockReason(credits, CREDIT_COSTS.targetedCorrection) }
          : {}),
      }
    : undefined;

  // Grouped by task instead of stacked. Sections keep their existing markup -
  // only where they live changes. Staff-only material inside a tab is a marked
  // frame within it (StaffOnlySection), not a tab of its own, so no tab is
  // built for one reader and empty for the other.
  //
  // Portal revamp, Surface 06: Profile now ALSO carries the identity a client
  // edits themselves — logo, social handles, bio — which used to live in the
  // rail (ClientProfilePanel, non-compact here: this tab has no no-scroll
  // contract to clamp it under).
  //
  // NO SEATS CARD ANY MORE (round 6, 2026-09). "Remove the Seats card from
  // Profile (not useful)." It was a read-only list of names that pointed at two
  // other pages, and those pages are the editors: a seat is a per-agent INPUT,
  // edited on the X intake page and the LinkedIn intake page, both reached from
  // the agent detail page's "What it runs on" band, which already lists one row
  // per seat with an anchor into its own card. Nothing linked to the card — no
  // `#seats` anchor exists anywhere in `src` — so nothing is orphaned by taking
  // it out, and the `listClientSeats` read left with it. Not to be confused with
  // the Settings tab's "Manage employee seats", which is the LinkedIn OAuth
  // `EmployeeSeat`, a different object, untouched.

  // Documents (moved off the rail). Same component, same reading experience
  // (bullet-summary-first via DocPanel's "In short" panel) — just a full-width
  // block now instead of a compact rail list. The reader is a panel here, not
  // the slide-over it used to be (`DocOverlay`), so the name moved with it.
  //
  // NO LONGER A TAB OF ITS OWN (portal feedback round 4, 2026-09): "the
  // documents can live in Profile." They are what the company IS, written down,
  // so they close the Profile tab rather than competing with it for a slot in
  // the side navigation. `?tab=documents` redirects to the anchor below.
  //
  // WHICH DOCUMENTS THIS CLIENT HAS ALREADY CONFIRMED (round 6, decision 3).
  // "Looks right" at the foot of an opened document writes the checklist row
  // the setup ladder's step 2 reads; handed back here, the foot says
  // "Confirmed" on a later visit instead of asking again. `not_relevant`
  // counts as answered: the row is a question the client has settled either
  // way, and re-asking a settled question is the thing this closes.
  const confirmedDocTypes: ContextDocType[] = actionStates
    .filter((row) => row.status === "done" || row.status === "not_relevant")
    .map((row) => CONFIRMABLE_DOC_TYPE_BY_ACTION_ID[row.actionId])
    .filter((docType): docType is ContextDocType => docType !== undefined);

  const documentsSection = (
    <ClientDocuments
      contextDocs={contextDocs}
      isAdmin={isAdmin}
      clientId={client.id}
      isAiProcessing={isAiProcessingLockActive(client)}
      aiProcessingFailed={hasAiProcessingFailure(client)}
      intelSchedule={clientIntelSchedule(client)}
      allowInternalFallback={isStaff}
      correctionPricing={correctionPricing}
      confirmedDocTypes={confirmedDocTypes}
      canConfirm={isClientViewer}
    />
  );

  const profileSection = (
    <div className="space-y-8">
      {/* ClientProfilePanel is a "use client" component — the whole prop it is
          handed serializes into the RSC payload whether or not anything it
          renders paints it. A CLIENT_USER (including a group admin) gets the
          same projection ClientRail uses (toClientPortalView), never the raw
          document — clientKeyId, aiProcessingError, forbiddenTopics,
          assignedEmployeeIds and the other staff-only fields on Client must
          not reach this branch. */}
      <ClientProfilePanel client={isStaff ? client : toClientPortalView(client)} />
      <BrandColorsSection
        guidelines={client.brandingGuidelines}
        clientId={client.id}
        hasWebsite={!!client.website}
        isStaff={isStaff}
      />
      {/* Documents, last of the client's own Profile blocks (portal feedback
          round 4, 2026-09). The `id` is what makes `?tab=profile#documents`
          land here — the anchor the retired `?tab=documents` deep link
          redirects to. ClientDocuments prints its own "Documents" heading, so
          this section deliberately does not stack a second one on top of it. */}
      {/* `scroll-mt-24` for the same reason #visibility-scores has it: the
          anchor jump would otherwise park this heading under the sticky page
          chrome (review wave, 2026-09). */}
      <section id="documents" className="scroll-mt-24">
        {documentsSection}
      </section>
      {/* PARITY PASS (2026-09). The staff record editor used to open this tab,
          pushing ClientProfilePanel and everything under it a full form down —
          so the two readers' Profile tabs began on different content and
          scrolled out of step for the whole rest of the tab. It is additive
          staff machinery, not the head of the client's own profile, so it goes
          last, inside the shared marker frame: same tab, same order, one extra
          block at the bottom that says what it is. */}
      {isStaff && (
        <StaffOnlySection label="Staff only · edit client record">
          <ClientEditor client={client} />
        </StaffOnlySection>
      )}
    </div>
  );

  // Competitors (new tab, moved off the rail's CompetitorTrack). `limit={null}`
  // — "holds everything we gather" — is the display cap only; the SEO/GEO
  // measurement roster (lib/intel/pipeline.ts) keeps reading
  // TRACKED_COMPETITOR_LIMIT unchanged, so raising what this tab shows does not
  // silently double that pipeline's per-capture cost.
  //
  // NO COLLAPSE ANY MORE (portal feedback round 4, 2026-09): "since it's
  // only competitors now we can show all of them right off the bat." The
  // 2026-08 six-row collapse was there because "everything we gather" opened as
  // an undifferentiated wall of names; the answer this round is to make each row
  // worth reading rather than to hide most of them. Each row now carries what we
  // already stored about that rival, so a long list scans instead of piling up.
  //
  // Everything below comes off data already in hand. No research, no network:
  // positioning, overlap, tier, strengths and weaknesses are on the competitor
  // row itself, and the AI-answer counts were written back onto those rows by
  // the last SEO/GEO capture (lib/intel/competitor-sync.ts).
  //
  // The one number the rows cannot hold themselves is the CLIENT's own count,
  // which is what turns "named in 4 answers" into a comparison. It is summed
  // here from the snapshot this page already read, over the same category
  // probes and the same run that produced every row's `llmMentions` — the brand
  // and navigational questions name the client by construction and would make
  // any share-of-conversation bar meaningless (the CD-B3 rule).
  //
  // AND ONLY FROM A SNAPSHOT THAT REALLY HAS THE CATEGORY SPLIT (review wave,
  // 2026-09). `categoryMetrics` falls back to an engine row's FULL-PROMPT
  // figures when it predates the `category` field, which is the right degrade
  // for a score but the wrong one here: those figures include the brand and
  // navigational questions, which name the client by construction, so a legacy
  // snapshot handed the rows an inflated client count and made every rival's
  // bar read shorter than it is. A capture we cannot split is no measurement of
  // share, so it renders no meter at all.
  const competitorAiVisibility = seoGeo
    ? (() => {
        const perEngine = seoGeo.perEngine ?? [];
        if (perEngine.some((engine) => !engine.category)) return null;
        let clientMentions = 0;
        let answersMeasured = 0;
        for (const engine of perEngine) {
          const cat = categoryMetrics(engine);
          answersMeasured += cat.promptsMeasured;
          clientMentions += cat.brandMentions.find((b) => b.isClient)?.mentions ?? 0;
        }
        // A capture that measured nothing is not a zero share, it is no
        // measurement — hand the component null so it renders no meter at all.
        //
        // `capturedAt` travels with the two counts so a row can check that its
        // own stored `llmMentions` came from THIS run before standing beside
        // them (see `CompetitorAiVisibility`).
        return answersMeasured > 0
          ? { clientMentions, answersMeasured, capturedAt: seoGeo.capturedAt }
          : null;
      })()
    : null;

  const competitorsSection = (
    <CompetitorTrack
      competitors={competitors}
      clientId={client.id}
      isStaff={isStaff}
      limit={null}
      title="Competitors"
      aiVisibility={competitorAiVisibility}
    />
  );

  // Reporting (portal revamp, Surface 09 — reporting consolidation). Search &
  // AI visibility used to be its own tab on the client dashboard; it moved
  // here, next to Competitors, so it has one home instead of rendering on two
  // pages. Same composition the dashboard tab used to build: headline scores,
  // then the action plan, then the full report.
  const trackedCompetitorRefs = computeTrackedCompetitors(competitors).map((c) => ({
    name: c.company,
    ...(c.url ? { url: c.url } : {}),
  }));
  // NO REPUTATION BUBBLE ANY MORE (round 6, 2026-09). A hand-built card for ONE
  // agent sat after the report with a three-way label and a green "Beta" badge
  // (`Badge tone="neon"`, which renders success green), and it was the only
  // "what Karos does" pointer on a tab full of scores. The Reputation agent is
  // now row 7 of <VisibilityWork/> below, beside every other agent that moves
  // these numbers, with the roster's own status word instead of a label invented
  // here. The beta marker does not carry over: it belongs on the agent's page if
  // anywhere.
  const visibilityPanel = (
    <SeoGeoPanel
      insights={seoGeo}
      trackedCompetitors={trackedCompetitorRefs}
      clientWebsite={client.website}
      isClientViewer={isClientViewer}
      intelScheduleEnabled={client.intelScheduleEnabled ?? false}
      intelScheduleNextRunAt={client.intelScheduleNextRunAt ?? null}
      isRefreshing={isAiProcessingLockActive(client)}
      // The scores are lifted to the top of this tab below when there is a
      // snapshot to lift them from, so the panel must not repeat them (same
      // rule the dashboard tab followed before the move).
      hideScores={!!seoGeo}
      // UNCONDITIONAL (portal feedback round 4, 2026-09). "What we're fixing"
      // is not rendered on a client-facing report any more, with or without a
      // snapshot to build it from: the ruling is that its rows are not true.
      // <ClientSuggestions/> below is what replaced it. Passed by name even
      // though the prop now defaults to true, so this page states the rule
      // rather than inheriting it.
      hidePlan
    />
  );
  // NO PERFORMANCE / CONNECTED CHANNELS HERE (portal feedback round 4,
  // 2026-09). ClientAnalytics mounted "Content by status" and "Connected
  // channels" at the top of this tab for both readers; the product owner's
  // ruling is that neither belongs under Reporting. Content by status is
  // inventory, and the channel list is a settings question that already has a
  // detailed home one tab away, next to the control that fixes a broken one.
  // Staff Home keeps its own ClientAnalytics mount, which is untouched.
  //
  // The tab is now one subject end to end: how visible you are, what only you
  // can change about that, and the measurement behind both.

  // The client-owned suggestions that replaced "What we're fixing" (portal
  // feedback round 4, 2026-09). Built here, on the server, from the same
  // snapshot the scores read: pure, capped at five, confirmed findings only,
  // and only the ones whose fix nobody at Karos can ship. See
  // `buildClientSuggestions` for the exact rules.
  //
  // `?? []` on both check arrays for the same reason `perEngine` already has
  // one (review wave, 2026-09): these are fields of a stored document, and a
  // snapshot written by an older pipeline can be missing either one. Spreading
  // undefined here would throw during render of a page that is otherwise
  // perfectly able to show the rest of the report.
  const clientSuggestions = seoGeo
    ? buildClientSuggestions(seoGeo.gaps ?? [], {
        checks: [...(seoGeo.seoChecks ?? []), ...(seoGeo.geoChecks ?? [])],
      })
    : { suggestions: [], emptyReason: "none" as const };

  /**
   * "What we are doing to improve your SEO and GEO" (round 6, 2026-09).
   *
   * ONE DERIVATION, TWO READERS. The rows come out of the same
   * `buildClientRosterEntries` the Agents page renders, so the status word here
   * is the word there and on the agent's own page — the fix for the bug Albert
   * named ("we pre-created content ... yet the page says runs on request"), and
   * the reason the roster build was extracted out of that page at all.
   *
   * The entries themselves are read in wave two above (round 6, alignment fix
   * 5), on the page's own clock — this block only shapes them into rows. There
   * is no staff-only branch on this tab beyond the panel's own
   * refresh-schedule frame.
   *
   * An agent with no lever never renders (the SEO/GEO agent IS the measurement;
   * a setup skill is a step of another agent), which is also what keeps an
   * unreviewed test agent off a client's report.
   */
  const clientDomain = rootDomain(client.website);
  const citationsByDomain = new Map(
    (seoGeo?.citationLeaderboard ?? []).map((row) => [row.domain, row.citations] as const),
  );
  const rosterVisibilityRows = rosterEntries.flatMap((entry) => {
    const lever = visibilityLeverFor({ key: entry.agentKey, name: entry.agentName });
    if (!lever) return [];
    const domain = citationDomainFor({ key: entry.agentKey, name: entry.agentName }, clientDomain);
    return [
      {
        key: entry.customAgentId,
        /**
         * WHAT THE ROW OPENS, and the one thing `granted` decides here (round 6
         * review, D4). A client opening an ungranted agent's page gets
         * `notFound()`, so an ungranted row loses its DESTINATION and keeps
         * Support — but it keeps its status WORD, because the agent has a real
         * state on this account (it has delivered work; that is why it is on the
         * roster at all) and "Not on your plan" over a shelf of delivered posts
         * is the section contradicting the Workspace.
         */
        customAgentId: entry.granted ? entry.customAgentId : null,
        identity: entry.identity,
        icon: entry.icon ?? null,
        displayName: entry.displayName,
        agentName: entry.agentName,
        lever,
        quotedCount: domain ? citationsByDomain.get(domain) ?? null : null,
        status: entry.status as RosterStatus | null,
      },
    ];
  });
  // THE CATALOGUE HALF (decision 7). A family this account has no row for at
  // all reads "Not on your plan" with Support, in the family's own words. It is
  // keyed on the FAMILY rather than on the agent key, so the one product that
  // spans several matcher rules contributes ONE row rather than one per regex.
  // Static table, no read.
  //
  // `status: null` IS the "Not on your plan" state (round 6 review, D4): the
  // section's own word is the absence of a roster word, not a flag beside one,
  // so there is no placeholder status for the badge to accidentally paint and no
  // second field for the two to disagree through. `customAgentId: null` removes
  // the Open control for the same reason it does above: there is nothing on this
  // account to open.
  const coveredFamilies = new Set(rosterVisibilityRows.map((row) => row.lever.family));
  const catalogueVisibilityRows = visibilityLeverFamilies()
    .filter((family) => !coveredFamilies.has(family.family))
    .map((family) => ({
      key: `family:${family.family}`,
      customAgentId: null as string | null,
      identity: family.markIdentity,
      icon: null,
      displayName: family.name,
      agentName: family.name,
      lever: family.lever,
      quotedCount: null as number | null,
      status: null as RosterStatus | null,
    }));
  // NO RE-SHAPING PASS (round 6 review, E4). `sortVisibilityWorkRows` returns
  // its input rows, so the `.map` that used to sit here rebuilt each row field
  // by field only to strip `lever` — the field the sort itself orders by, and
  // the field that carries the sentence the row prints. The duplicated
  // `sentence` beside it went with it: one source, read as `row.lever.sentence`.
  const visibilityWorkRows: VisibilityWorkRow[] = sortVisibilityWorkRows([
    ...rosterVisibilityRows,
    ...catalogueVisibilityRows,
  ]);
  const visibilityWork = <VisibilityWork clientId={client.id} rows={visibilityWorkRows} />;

  // No snapshot yet: skip straight to the panel's own empty state rather than
  // showing a headed, empty "Visibility scores" section above it (F23's "no
  // disclosure that opens onto an empty box", applied to headers instead of a
  // disclosure).
  //
  // ORDER (round 6, 2026-09): where you stand, what we are doing about it,
  // where you stand against competitors, the working, and last what only you
  // can do. Albert: "Move 'Things only you can do' to the very bottom of
  // Reporting" and "ADD above it a section". So the scores answer the question
  // the tab is named after, the agent rows say what is moving them, the panel
  // is the comparison and the evidence behind both, and the one section that
  // asks the READER for anything closes the tab rather than interrupting it.
  const reportingSection = seoGeo ? (
    <div className="space-y-8">
      {/* The anchor Home's Visibility KPI links to (portal feedback round 5,
          2026-09): that cell is a headline of these scores, so it opens the
          section it is a headline OF rather than the top of the tab.
          `scroll-mt` keeps the heading clear of the sticky page chrome. */}
      <section id="visibility-scores" className="scroll-mt-24 space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
          Visibility scores
        </p>
        <SeoGeoScores insights={seoGeo} />
      </section>
      {visibilityWork}
      {visibilityPanel}
      <ClientSuggestions
        suggestions={clientSuggestions.suggestions}
        emptyReason={clientSuggestions.emptyReason}
      />
    </div>
  ) : (
    // No snapshot: the panel's empty state leads, and the agent rows still
    // stand — what we are doing does not depend on having measured it yet. The
    // suggestions stay unrendered without a snapshot, as before: every row in
    // them is a finding OF one.
    <div className="space-y-8">
      {visibilityPanel}
      {visibilityWork}
    </div>
  );

  /*
   * NO ARCHIVE SECTION HERE (portal feedback round 2, 2026-09). It was a tab of
   * this page, fed by the same ArchiveView the calendar mounts — "Archive does
   * not need to be in settings, it's in the calendar". The `?status=` narrowing
   * that used to sit here (through `offeredStatesFor`, so a hand-crafted
   * `status=draft` degrades to the unfiltered list rather than an empty one)
   * moved WITH it, to calendar-body.tsx; the rule is unchanged, only its home.
   */

  // `CreditLedgerEntry.actorName`/`.actorUid` are staff-internal — set to the
  // admin's own name+uid on a manual grant/deduct (adjustCreditsAction) — and
  // CreditsPanel is a "use client" component, so whatever crosses here is
  // readable from view-source whether or not the panel paints it. Only
  // `.reason` is classified client-safe by client-copy-boundary.test.ts's
  // NOT_ON_A_CLIENT_SCREEN/CLIENT_READ sweep; actor identity is not, so it is
  // stripped before a client viewer's slice is built rather than left to the
  // panel to withhold at render.
  //
  // `actualUsd` AND `settlementCapped` JOIN THE STRIP (credits rework, 2026-09),
  // and they are the reason this list is worth re-reading rather than extending
  // by habit. `actualUsd` is OUR COST IN DOLLARS for that run — the single
  // number the two-audience split exists to keep away from clients (it is what
  // the staff-only economics card is hard-gated for), and settlement rows now
  // carry it on the same objects this feed is built from. `settlementCapped`
  // says a run cost us more than double what we quoted, which is the same
  // disclosure in weaker form.
  //
  // Stripped rather than withheld at render for the reason the actor fields
  // are: CreditsPanel is a "use client" component, so anything crossing this
  // boundary sits in the page payload and is readable from view-source whether
  // the panel paints it or not. Staff keep both fields; a client viewer's slice
  // never carries them.
  const clientLedgerFeed = redactLedgerForClient(creditLedger.slice(0, LEDGER_FEED_LIMIT));

  const creditsSection = (
    <CreditsPanel
      clientId={client.id}
      credits={credits}
      ledger={isStaff ? creditLedger.slice(0, LEDGER_FEED_LIMIT) : clientLedgerFeed}
      spendByAgent={spendByAgent}
      monthlyCost={monthlyCost}
      pricesAreEstimates={isCreditsPlanV2Enabled()}
      role={user.role}
      viewer={{ name: user.name, email: user.email }}
    />
  );

  const channelsSection = (
    <IntegrationsTab
      clientId={client.id}
      integrations={sanitizedIntegrations}
      oauthEnabledPlatforms={oauthEnabledPlatforms}
      googleBusinessProfileRequested={googleBusinessProfileRequested()}
      currentUserRole={user.role}
      linkedinSeats={sanitizedLinkedinSeats}
      seatLimit={client.linkedinSeatLimit ?? DEFAULT_LINKEDIN_SEAT_LIMIT}
      seatCost={CREDIT_COSTS.employeeSeat}
    />
  );

  const automationSection = (
    <div className="space-y-8">
      <AutoScheduleToggle clientId={client.id} enabled={settings?.autoScheduleEnabled} />
    </div>
  );

  /**
   * PARITY PASS (2026-09). The two admin cards used to sit INSIDE
   * `automationSection`, between the client's own auto-schedule toggle and the
   * Channels/Team blocks around it — styled as ordinary Cards, so an admin
   * previewing the Settings tab read a strip of controls with no way to tell
   * which three of them the client would actually find there. They are lifted
   * out whole (nothing about either card changed) into one marked frame that
   * closes the tab, after everything the client shares.
   *
   * One frame around both rather than one each: they are the same audience and
   * the same claim, and two adjacent dashed boxes would say it twice.
   */
  const adminAutomationSection = isAdmin ? (
    <StaffOnlySection label="Admin only">
      {/* Agent access (admin) - which custom agents this client may fire themselves */}
      <Card>
        <CardTitle className="mb-1">AI agent access</CardTitle>
        <p className="mb-3 text-sm text-muted-2">
          Agents this client&apos;s users can run from their AI agents page. Each run charges the
          client&apos;s credits.
        </p>
        <ClientAgentAccessCard
          clientId={client.id}
          agents={clientAgents}
          allowedIds={client.customAgentIds ?? []}
        />
      </Card>

      {/* Scheduled runs (admin) - recurring generators fired on a cadence, draft-first + free */}
      <Card>
        <CardTitle className="mb-1">Scheduled runs</CardTitle>
        <p className="mb-3 text-sm text-muted-2">
          Fire a custom agent for this client on a recurring cadence (e.g. the LinkedIn
          company-page generator, Tue–Thu). Runs are draft-first and never charge the
          client&apos;s credits — the model spend is ours and appears in no credit ledger.
        </p>
        {/* Where these DON'T show up. A schedule nobody can see is a schedule
            nobody turns off, and this card creates rows that are absent from
            the calendar entirely and separate from the pace on the AI agents
            page — so an agent can be running on both at once. Said here, on
            the only surface that can create one. */}
        <p className="mb-3 text-sm text-muted-2">
          These are separate from an agent&apos;s pace on the AI agents page, and they do not
          appear on the calendar. An agent can be running on both at once — check the AI agents
          page, which now lists any schedule set here.
        </p>
        <ScheduledRunsCard
          clientId={client.id}
          runs={scheduledRuns}
          agents={clientAgents
            .filter((a) => a.enabled)
            .map((a) => ({ id: a.id, name: a.name, entrySkillDir: a.entrySkillDir }))}
        />
      </Card>
    </StaffOnlySection>
  ) : null;

  /**
   * THE MEETINGS SURFACE A CLIENT REACHES (AF-1).
   *
   * It is exactly where the product owner wants it — "I like that in the
   * settings" — and it is the whole of a client's route to their calls, so a
   * later edit that thins it out would be removing the destination rather than
   * a duplicate of one.
   *
   * NO LONGER A TAB OF ITS OWN (portal feedback round 2, 2026-09): "Meetings
   * can be a sub-section in, like, account settings." Same card, same rows,
   * rendered last inside `settingsSection` below. The `id` is what makes
   * `?tab=settings#meetings` land on it — the anchor the old `?tab=meetings`
   * deep link redirects to.
   *
   * AND IT NOW CARRIES THE ROUTE TO THE LIST (flow audit 2026-09, R11/F14).
   * This card shows the 12 most recent calls and used to stop there, so an
   * older meeting was unreachable from here; `/transcripts` itself had no rail
   * row by ruling and was reachable only through the notification bell's
   * footer, which appeared only when the client happened to have meeting action
   * items — three inconsistent states for one page. That footer link is gone,
   * so this is the client's one route to the full list, and it renders whenever
   * there is a list to open rather than only past the truncation: the count is
   * what changes, not whether the way through exists.
   *
   * THE LINK IS SCOPED FOR STAFF (review wave, 2026-09). "See all 34 meetings"
   * pointed at the bare `/transcripts`, which for a staff reader is the
   * CROSS-CLIENT list: the count came from this client's calls and the
   * destination showed everyone's. `?client=` scopes it (see that page); a
   * client reader's own list is already scoped by their session, so their link
   * is unchanged.
   */
  const meetingsSection = (
    <Card id="meetings" className="scroll-mt-24">
      <CardTitle className="mb-3">Meetings</CardTitle>
      {transcripts.length === 0 ? (
        <p className="text-sm text-muted-2">
          No meetings linked yet. Calls synced from Fireflies appear here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {recentTranscripts.map((t) => (
            <li key={t.id}>
              <Link
                href={`/transcripts/${t.id}?from=${encodeURIComponent(`/clients/${client.id}/settings?tab=settings#meetings`)}`}
                className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-2/40"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <p className="text-xs text-muted-2">{relativeTime(t.meetingDate ?? t.createdAt)}</p>
                </div>
                <Icon name="ChevronRight" className="h-4 w-4 shrink-0 text-muted-2" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {transcripts.length > 0 && (
        /* A quiet TEXT link, not a row (round 6, rule 2): the rows above it
           carry the chevron because each one is a whole-surface destination,
           and a glyph after a text link is the "one row affordance, four
           spellings" finding. `hover:text-neon` was a fourth hover recipe on
           one card and is not a rule anywhere in globals.css. */
        <Link
          href={isStaff ? `/transcripts?client=${encodeURIComponent(client.id)}` : "/transcripts"}
          className="focus-ring mt-3 inline-block rounded-[4px] text-sm font-medium text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          {transcripts.length > MEETING_ROWS
            ? `See all ${transcripts.length} meetings`
            : "See all meetings"}
        </Link>
      )}
    </Card>
  );

  /**
   * The viewer's own account panels — built only for the client whose page this
   * is (see the block on `tabs`). The Firebase Auth record is read for the same
   * reason /settings reads it: the security panel offers a password form only
   * to an account that HAS a password, and which providers are linked lives on
   * the auth record rather than on the app user.
   */
  const accountTabs: SettingsTab[] | null =
    user.role === "CLIENT_USER"
      ? (() => {
          // Read in the Promise.all above, so this branch only shapes it.
          const providers = viewerAuthRecord?.providerData.map((p) => p.providerId) ?? [];
          return [
            {
              id: ACCOUNT_TABS.profile,
              label: "Profile information",
              group: "Your account",
              icon: "User",
              content: <AccountProfilePanel user={user} clientName={client.name} />,
            },
            {
              id: ACCOUNT_TABS.security,
              label: "Account security",
              group: "Your account",
              icon: "Shield",
              content: <AccountSecurityPanel providers={providers} />,
            },
          ];
        })()
      : null;

  // F56: the key is a standing credential — staff and the workspace's own group
  // admin only, and whoever can see it can rotate it.
  const teamSection =
    client.clientKeyId && (isStaff || user.isGroupAdmin) ? (
      <Card>
        <CardTitle className="mb-1">Invite your team</CardTitle>
        <p className="mb-3 text-sm text-muted-2">
          Share this key with a teammate so they can join your workspace.
        </p>
        <ClientKeyInline clientKeyId={client.clientKeyId} clientId={client.id} canRotate />
      </Card>
    ) : null;

  // "Settings becomes a tab inside it" (locked decision) — Channels,
  // Automation and Team are all sub-sections of ONE generic Settings tab now,
  // rather than three of Account Center's top-level tabs. Nothing about any
  // of the three sections themselves changed; only which tab they live under.
  //
  // Meetings joined them (portal feedback round 2, 2026-09) as the LAST of the
  // client's own sub-sections: it is a list a client visits occasionally, not a
  // control they set, so it reads after the three that configure the account —
  // and still ahead of the admin-only frame, which by the parity rule closes
  // every tab it appears on.
  const settingsSection = (
    <div className="space-y-8">
      {channelsSection}
      {automationSection}
      {teamSection}
      {meetingsSection}
      {/* PARITY PASS (2026-09): the admin-only pair closes the tab, so
          everything above it is exactly what the client reads, in their order. */}
      {adminAutomationSection}
    </div>
  );

  // Five tabs, down from eight: Archive left for the calendar and Meetings
  // folded into Settings (portal feedback round 2, 2026-09), then Documents
  // moved into Profile (round 4). All three old ids still resolve — see the
  // redirect block at the top of this page.
  const sections: SettingsTab[] = [
    // Grouped for the side navigation (portal feedback round 2, 2026-09):
    // what the company IS, then how the workspace RUNS, then — for a client —
    // their own account. Order inside a group is by how often it is opened.
    { id: "profile", label: "Profile", icon: "Building2", group: "Company", content: profileSection },
    { id: "competitors", label: "Competitors", icon: "Users", group: "Company", content: competitorsSection },
    { id: "reporting", label: "Reporting", icon: "Radar", group: "Company", content: reportingSection },
    { id: "settings", label: "Settings", icon: "Settings", group: "Workspace", content: settingsSection },
    { id: "credits", label: "Credits", icon: "Coins", group: "Workspace", content: creditsSection },
  ];
  // NO `.filter(t => t.content !== null)` (review wave, 2026-09). It was here
  // for a tab whose content could collapse to null when everything in it was
  // staff-gated; none of the five can any more (each builds an element
  // unconditionally, and the staff-only parts are frames INSIDE them), so the
  // filter dropped nothing and only claimed a rule this list had stopped
  // following. A tab that really does become empty should stop being built,
  // not be swept up here.

  /**
   * THE VIEWER'S OWN ACCOUNT, AS TABS ON THIS PAGE (AF-2).
   *
   * These were an "Account settings" entry that navigated to /settings — a
   * second settings page with a second tab strip. "It's just supposed to be
   * seamless", so the two panels are tabs here and /settings redirects a client
   * back to them.
   *
   * CLIENT_USER only, and that is the whole distinction rather than a
   * gate-by-default: this page is about the CLIENT, and for a client their
   * company and their account are the same settings surface. For staff it is
   * somebody else's company, and their own account is /settings — putting their
   * password form on a client's page would be the hop back again, pointing the
   * other way.
   */
  const tabs: SettingsTab[] = accountTabs ? [...sections, ...accountTabs] : sections;

  return (
    <>
      <PageHeader
        title="Account Center"
        /* Names what the five tabs actually hold now (review wave, 2026-09).
           The old line stopped at "reporting and credits", which left the
           Settings tab — channels, automation, your team and every meeting a
           client can read — unannounced under a word that could mean anything. */
        description="Profile and documents, competitors, reporting, settings for channels, automation, your team and meetings, and credits: everything that is not daily use, in one place."
        action={
          isStaff ? (
            /* Kept (a client reaches their own account through the two tabs at
               the end of the strip; staff have to hop to /settings), but PARITY
               PASS (2026-09) marks it: it is the one thing in this header that
               only one of the two readers has, and unmarked it read as part of
               the client's own page furniture. */
            <span className="flex items-center gap-2">
              <Link
                href={`/settings?returnTo=${encodeURIComponent(
                  `/clients/${client.id}/settings${initialTab ? `?tab=${initialTab}` : ""}`,
                )}`}
                className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
              >
                Your account settings
              </Link>
              <Badge tone="neutral">Internal</Badge>
            </span>
          ) : undefined
        }
      />

      {/* CLIENT_USER already sees this via the (app) shell's own wrapper - only
          render here for staff, who use the plain Sidebar shell with no such wrapper. */}
      {user.role !== "CLIENT_USER" && (
        <div className="mb-6">
          <AiProcessingBanner client={client} isAdmin={user.role === "KAROS_ADMIN"} />
        </div>
      )}

      {/* The Account card that used to close this page held nothing but a Sign
          out button, which already lives in the rail's account menu. */}
      <SettingsTabs tabs={tabs} initialTab={initialTab} />
    </>
  );
}
