import { redirect } from "next/navigation";
import { getViewingContext } from "@/lib/auth";
import {
  countPendingRegistrations,
  listClients,
  listAssignedActionItems,
  listReviewJobs,
  listReviewJobsForClients,
  listClientTasks,
  getClient,
  getClientCredits,
  getClientReport,
  listClientIntegrations,
  listCustomAgents,
  updateClient,
} from "@/lib/data";
import { railAgentsForClient } from "@/lib/rail-agents";
import { ActiveClientProvider } from "@/lib/active-client-context";
import { availableCredits } from "@/lib/credits";
import { clientSafeTaskAlerts, type TaskAlert } from "@/lib/notification-rows";
import { orderSetupLadderAgents, rankSetupLadder } from "@/lib/setup-ladder";
import {
  toClientPortalView,
  toStaffPickerView,
  type StaffPickerClientView,
} from "@/lib/client-visibility";
import { integrationIsUsable } from "@/lib/integration-status";
import { shouldBlockForOnboarding } from "@/lib/onboarding";
import { Sidebar } from "@/components/sidebar";
import { ClientRail } from "@/components/client-rail";
import { CopilotDock } from "@/components/copilot-dock";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { AiProcessingBanner } from "@/components/ai-processing-banner";
import { ClientContextBar } from "@/components/client-context-bar";
import { StaffCopilotDock } from "@/components/staff-chatbot-widget";
import { StaffShellMain } from "@/components/staff-shell-main";
import type { ActionItemNotification, AgentReviewNotification, Client, ClientTask } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isImpersonating, realAdmin } = await getViewingContext();

  // Block the entire portal until a freshly-created client account finishes the
  // 2-step onboarding wizard. Checked first - before any other data fetching.
  // Exempt impersonation: staff "viewing as" an unonboarded client must land on
  // the real dashboard, not get funneled into (and stuck in) that client's wizard.
  if (shouldBlockForOnboarding({ isImpersonating, user })) redirect("/onboarding");

  let pendingCount = 0;
  // The PROJECTION, not the documents: this array is a prop of the Sidebar, a
  // "use client" component that renders on every staff page, so a whole Client
  // here puts every client's join token into every one of those RSC payloads.
  // StaffPickerClientView carries exactly what a picker ROW paints — a favicon
  // and a name — and nothing else. The wider StaffShellClientView belongs to
  // the ONE client whose context is open, which ClientContextSync supplies from
  // the /clients/[id] layout; see both notes in client-visibility.ts.
  let clients: StaffPickerClientView[] = [];

  // Staff bell feeds are cross-client, so they need the viewer's client scope:
  // admins see every client, an employee only their assigned ones - the same
  // fence /jobs, /assets and the task board use.
  const isStaffViewer = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const staffClients: Client[] = isStaffViewer
    ? await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined)
    : [];
  const staffClientNames = new Map(staffClients.map((c) => [c.id, c.name]));

  const [pendingRegistrations, actionItems, reviewJobs, taskAlerts] = await Promise.all([
    // ONE listClients() PER REQUEST (review wave, 2026-09). This branch used to
    // fetch the whole client collection a second time for an admin, and
    // `listClients(undefined)` is exactly what `staffClients` already holds for
    // that role — the same read, the same answer, paid for twice on every staff
    // page. The one admin-specific number left is the registrations badge, and
    // it no longer costs the whole user roster per request either: it used to
    // read every user document to count the pending ones (review, 2026-09).
    user.role === "KAROS_ADMIN" ? countPendingRegistrations() : Promise.resolve(0),
    // CLIENT_USER notifications are strictly scoped to their own client account;
    // a client user with no clientId has no company context, so no items at all.
    user.role === "CLIENT_USER"
      ? user.clientId
        ? listAssignedActionItems(user.uid, { forClientId: user.clientId })
        : Promise.resolve([] as ActionItemNotification[])
      : listAssignedActionItems(user.uid),
    // Reviews + tasks: the client's own, or - for staff - everything in their
    // client scope. These two feeds used to be handed empty arrays to staff, so
    // "Ready for review" and "Pending tasks" were structurally unreachable for
    // the people who run the agency, and the bell claimed "All caught up!"
    // while drafts sat in review (QA F68).
    user.role === "CLIENT_USER"
      ? user.clientId
        ? listReviewJobs(user.clientId, { limit: 15 })
        : Promise.resolve([] as AgentReviewNotification[])
      : listReviewJobsForClients([...staffClientNames.keys()], { limit: 15 }),
    user.role === "CLIENT_USER"
      ? user.clientId
        ? listClientTasks({
            clientId: user.clientId,
            status: ["pending", "review_pending"],
            limit: 50,
          })
        : Promise.resolve([] as ClientTask[])
      : // THE SCOPE GOES INTO THE QUERY, not into a filter after it (review
        // wave, 2026-09). A global "newest 200" read fenced afterwards is the
        // right answer for an admin, whose scope IS every client — but an
        // employee is fenced to their assignments, so their bell showed only
        // the tasks that happened to make the agency-wide top 200. An employee
        // at a busy agency could have every one of their clients' tasks fall
        // outside it and be told "All caught up!". `listClientTasks` chunks the
        // id list into `in` queries itself; the admin keeps the single global
        // read, which is cheaper than 30-at-a-time over the whole roster.
        listClientTasks({
          ...(user.role === "KAROS_EMPLOYEE" ? { clientIds: [...staffClientNames.keys()] } : {}),
          status: ["pending", "review_pending"],
          limit: 200,
        }),
  ]);

  // Annotate staff rows with the client name (same pattern as tasks-body) and
  // fence them to the viewer's scope.
  const scopedReviewJobs: AgentReviewNotification[] = isStaffViewer
    ? reviewJobs.map((j) => ({ ...j, clientName: staffClientNames.get(j.clientId) ?? undefined }))
    : reviewJobs;
  // Staff keep the full ClientTask per row (the forensic detail is their job);
  // the OTHER arm of this ternary is a CLIENT_USER who fell through to the staff
  // shell because their client document would not resolve, and they were being
  // handed the raw documents (review wave, 2026-09). That shell is "use client",
  // so a raw ClientTask there ships `metadata.executionError`, `sourceLabel`,
  // `metadata.aiPlan`, `adjustmentFeedback`, `externalJobId` and a `createdBy`
  // uid into a client viewer's RSC payload — the exact leak `clientSafeTaskAlerts`
  // exists to close, applied one branch short. Same call the resolvable-client
  // branch below already makes.
  const scopedTaskAlerts: TaskAlert[] = isStaffViewer
    ? taskAlerts
        .filter((t) => staffClientNames.has(t.clientId))
        .slice(0, 20)
        .map((t) => ({ ...t, _clientName: staffClientNames.get(t.clientId) }))
    : clientSafeTaskAlerts(taskAlerts);

  pendingCount = pendingRegistrations;
  // AN EMPLOYEE'S PICKER WAS EMPTY (ruling D24, parity pass 2026-09). `clients`
  // was seeded only inside the admin branch above, and that branch is
  // skipped for a KAROS_EMPLOYEE — so the "Client context" picker at the foot of
  // their rail listed nothing at all and the whole client-context shell was
  // unreachable for them. `staffClients` is the same fence every other employee
  // surface uses (listClients({ employeeId })), already fetched above, so the
  // fix costs no extra read: admins get every client, employees their assigned
  // ones, and a CLIENT_USER's `staffClients` is `[]` by construction. It is now
  // the ONLY source too: the admin branch above used to fetch its own copy of
  // the same list (review wave, 2026-09).
  clients = staffClients.map(toStaffPickerView);

  // ── Client portal shell (CLIENT_USER only) ──
  if (user.role === "CLIENT_USER" && user.clientId) {
    const client = await getClient(user.clientId);
    if (client) {
      // contextDocs/competitors/correctionPricing no longer feed ClientRail —
      // Documents, Competitor Track and Brand Colors all moved to Account
      // Center (portal revamp, Surface 01/06), which fetches its own data on
      // its own route rather than riding along on every page's layout.
      const [integrations, report, credits, customAgents] = await Promise.all([
        listClientIntegrations(user.clientId),
        getClientReport(user.clientId),
        getClientCredits(user.clientId),
        listCustomAgents(),
      ]);

      // The rail's "AI agents" dropdown (Surface 01) — GRANTED agents, PLUS any
      // agent already starred even without a grant (2026-08). The filter itself
      // moved to lib/rail-agents.ts in the parity pass 2026-09: the staff
      // shell's client-context arm renders the same roster for the same client
      // (ruling D3), and the two must not be able to answer differently. See
      // that module for why each clause is there.
      const railAgents = railAgentsForClient(customAgents, client);

      // Onboarding default stars ("Karos sets the first stars at onboarding,
      // to steer what they use" — SOW p.4). Checked on `=== undefined`, not
      // `.length === 0`: a client who stars something and later unpins back
      // down to zero has made a choice, and `toggleStarredAgentAction` always
      // writes a real (possibly empty) array, never `undefined` — so this
      // fires exactly once per client, the first time their rail is ever
      // built, and never again once any stars exist. Every client onboarded
      // before this field existed reads as `undefined` today, which is the
      // "existing users" backfill case as well as the fresh-signup case; both
      // get the same one-time default. Awaited, not fire-and-forget: it only
      // runs once per client ever, and awaiting means THIS render already
      // reflects it, instead of the pinned rows appearing a navigation later.
      //
      // WHICH two, decided rather than taken off the top (review wave,
      // 2026-09). `railAgents` inherits `listCustomAgents()`'s name sort today,
      // so `slice(0, 2)` was quietly alphabetical — a pick nothing in this file
      // stated and any change to that upstream sort would silently rewrite. The
      // order is now the SETUP LADDER's, the same ranking the client's own Home
      // uses to decide which agent to walk them through first (setup-ladder.ts):
      // stored at onboarding when it exists, recomputed deterministically when
      // it does not, ties broken by position so the answer is stable either way.
      // Two default stars that disagree with the first step of "Get set up"
      // would be steering the client two ways at once.
      //
      // AND THIS IS A WRITE DURING RENDER, deliberately kept. It fires at most
      // once per client ever (the `=== undefined` guard above), and awaiting it
      // is what puts the pinned rows in THIS paint instead of a navigation
      // later. Anything that made it fire repeatedly would be a write on every
      // page load of every staff and client session — so the guard above is
      // load-bearing, not defensive.
      if (client.starredAgentIds === undefined && railAgents.length > 0) {
        const ladderOrder = client.setupLadderOrder?.length
          ? client.setupLadderOrder
          : rankSetupLadder({
              agents: railAgents.map((a) => ({ id: a.id, key: a.key, name: a.name })),
              category: client.category,
              socialLinks: client.socialLinks,
              connectedPlatformIds: integrations
                .filter(integrationIsUsable)
                .map((i) => i.platform),
              starredAgentIds: client.starredAgentIds,
              website: client.website,
              brandVoice: client.brandVoice,
            });
        const defaultStarredIds = orderSetupLadderAgents(railAgents, ladderOrder)
          .slice(0, 2)
          .map((a) => a.id);
        await updateClient(client.id, { starredAgentIds: defaultStarredIds });
        client.starredAgentIds = defaultStarredIds;
      }

      // The SPENDABLE figure, not the raw balance. The pill is labelled "credits
      // remaining", and what the charge transaction actually enforces is the
      // balance clipped by the weekly/monthly caps. This is the same call the
      // Agents page makes, so the rail and that page can no longer print two
      // different "available" numbers for the same second.
      // `now` is omitted on purpose: getClientCredits rolls the spend windows on
      // read, and it just ran in this same request, so the doc is already
      // current. Calling Date.now() here would only add an impure call in render
      // (react-hooks/purity) for no behavioural gain.
      const spendableCredits = availableCredits(credits);

      // Same rule as the docs above, applied to the client record itself: the
      // rail is a "use client" component, so the WHOLE document would be
      // serialized into every client-portal RSC payload - including
      // clientKeyId, the join token that auto-approves any signup into this
      // workspace (QA F56). Whitelist-projected before it crosses.
      const clientView = toClientPortalView(client);

      return (
        <ActiveClientProvider>
          <div className="flex min-h-screen flex-col md:flex-row">
            <ClientRail
              user={user}
              client={clientView}
              agents={railAgents}
              actionItems={actionItems as ActionItemNotification[]}
              reviewJobs={reviewJobs}
              taskAlerts={clientSafeTaskAlerts(taskAlerts)}
              spendableCredits={spendableCredits}
            />

            <div className="flex min-w-0 flex-1 flex-col">
              {isImpersonating && realAdmin && (
                <ImpersonationBanner realAdmin={realAdmin} viewingAs={user} />
              )}
              <main className="flex-1 overflow-x-clip px-4 pb-28 pt-6 md:px-8 md:pt-8 md:pb-16 lg:pb-8">
                {/* Same cap as the staff shell - the two shells must render pages
                    at identical widths or tabs appear to change size. */}
                <div className="@container mx-auto w-full max-w-6xl animate-fade-up">
                  {/* The client shell - this banner's audience is a CLIENT_USER,
                      who has neither Regenerate nor Refresh Task Map (F20). */}
                  <AiProcessingBanner client={clientView} isClientViewer />
                  {children}
                </div>
              </main>
            </div>

            <CopilotDock
              clientId={client.id}
              viewerUid={user.uid}
              clientName={client.name}
              userName={user.name}
              hasGoogleIntegration={integrations.some(
                (i) => i.platform === "google" && integrationIsUsable(i),
              )}
              report={
                report ? { overallGrade: report.overallGrade, overallScore: report.overallScore } : null
              }
            />
          </div>
        </ActiveClientProvider>
      );
    }
  }

  // ── Staff workspace shell ──
  return (
    <ActiveClientProvider>
      <div className="flex min-h-screen flex-col md:flex-row">
        {/* Support, light/dark and the bell used to float in an AppHeader strip
            at the top right of every staff page. CD-G9c retired that strip -
            the rail's account menu carries them now, and the Company sheet
            carries them at narrow width in client context. */}
        <Sidebar
          user={user}
          pendingCount={pendingCount}
          realAdmin={realAdmin}
          clients={clients}
          actionItems={actionItems as ActionItemNotification[]}
          reviewJobs={scopedReviewJobs}
          taskAlerts={scopedTaskAlerts}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {isImpersonating && realAdmin && (
            <ImpersonationBanner realAdmin={realAdmin} viewingAs={user} />
          )}
          {/* Client-context mode gets its own persistent bar - see F60. */}
          <ClientContextBar />
          {/* Scroll reserve, and it is CONDITIONAL here where the client shell's
              is flat — the bottom chrome it clears (tab bar + copilot strip)
              only exists in client-context mode. StaffShellMain reads the same
              context both of those gate on; see #127 in that file. */}
          <StaffShellMain>
            <div className="@container mx-auto w-full max-w-6xl animate-fade-up">{children}</div>
          </StaffShellMain>
        </div>
        {/* Docked copilot right-rail - visible when admin selects a client via "View as Client" */}
        <StaffCopilotDock userName={user.name} viewerUid={user.uid} />
      </div>
    </ActiveClientProvider>
  );
}
