import { after } from "next/server";
import { streamText, tool, generateObject, isLoopFinished, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { ModelMessage } from "ai";

import { getCurrentUser } from "@/lib/auth";
import {
  getClient,
  getClientReport,
  listClientCompetitors,
  listClientContextDocs,
  listJobs,
  listAssets,
  getAsset,
  updateClient,
  upsertClientContextDoc,
  getClientContextDoc,
  listClientIntegrations,
  markIntegrationExpired,
  createClientTask,
  getTaskBoardCapacity,
  getClientPerformanceBenchmarks,
  chargeClientCredits,
  getClientCredits,
} from "@/lib/data";
import { listClientAgents, listClientAgentFeedback } from "@/lib/data-client-agents";
import { findDuplicateReason } from "@/lib/task-dedup";
import {
  CREDIT_COSTS,
  TASK_EXECUTION_COSTS,
  CreditError,
  isBillableClientActor,
  availableCredits,
} from "@/lib/credits";
import type { ClientCredits } from "@/lib/types";
import { buildCopilotSystemPrompt } from "@/lib/copilot-context";
import {
  brandingToolRefusal,
  copilotToolsFor,
  GMAIL_UNAVAILABLE_MESSAGE,
  integrationBelongsToCaller,
  isStaffCopilotActor,
} from "@/lib/copilot-tool-access";
import { assetStatusLabel } from "@/lib/asset-status-copy";
import { clientSafeRunError, CLIENT_SAVE_REFUSAL_MESSAGE } from "@/lib/custom-agent-launch";
import { isAssetUnlockedForClient } from "@/lib/post-chain";
import { isLaunchDeliverable, isTestRunAsset } from "@/lib/asset-visibility";
import { resolveContentIdentity, type ClientAgentIdentity } from "@/lib/agent-identity-map";
import { buildProactiveSystemAppendix, buildGmailExtractionPrompt } from "@/lib/ai/prompts/proactive-assistant";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import { getClientCustomAgents, buildAgentCatalog } from "@/lib/agent-roster";
import { integrationIsUsable, integrationNeedsReconnect } from "@/lib/integration-status";
import { sendEmail } from "@/lib/email";
import { brandingToContextDocContent } from "@/lib/branding";
import { fetchGmailMessages, GmailTokenExpiredError } from "@/lib/integrations/gmail";
import { logger } from "@/services/logger";
import { runCustomAgentAction } from "@/lib/actions/custom-agent-actions";
import { updateAssetAction, clientRescheduleAssetAction, scheduleAssetAction } from "@/lib/actions/asset-actions";
import { addClientAgentFeedbackAction } from "@/lib/actions/client-agent-feedback-actions";
import {
  FEEDBACK_CATEGORIES,
  renderFeedbackMarkdown,
} from "@/lib/client-agent-feedback";
import type { Asset, BrandingGuidelines, TaskOwner, TaskSource, TaskPriority } from "@/lib/types";
import { MODELS, MAX_ACTIVE_TASKS } from "@/lib/constants";

export const maxDuration = 60;

const STOP_WHEN = [isLoopFinished(), stepCountIs(6)];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: clientId } = await params;

  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as {
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
    /** Set by the `@agent` mention chip — focuses the system prompt on one live umbrella. */
    focusAgentId?: string;
    /**
     * This is a plain chatbot, so it defaults to Haiku — the 3 substantive
     * proactive actions (Competitor Deep-Dive, Brand Visibility Audit,
     * Content Plan) opt into Sonnet by setting this, since they run
     * multi-step tool orchestration over a full strategy write-up rather
     * than a quick Q&A turn. Everything else, including plain questions and
     * a focused-agent conversation, stays on the cheap model.
     */
    deep?: boolean;
  };
  const messages = (body.messages ?? []) as ModelMessage[];
  const modelId = body.deep ? MODELS.SONNET : MODELS.HAIKU;
  const MODEL = anthropic(modelId);

  const [client, report, competitors, contextDocs, jobs, assets, integrations, boardCapacity, benchmarks, customAgents, umbrellas] =
    await Promise.all([
      getClient(clientId),
      getClientReport(clientId),
      listClientCompetitors(clientId),
      listClientContextDocs(clientId),
      listJobs({ clientId }),
      listAssets({ clientId }),
      listClientIntegrations(clientId),
      getTaskBoardCapacity(clientId),
      getClientPerformanceBenchmarks(clientId),
      getClientCustomAgents(clientId),
      listClientAgents({ clientId }),
    ]);
  const liveUmbrellas = umbrellas.filter((u) => u.launchState === "live");

  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  // Client users spend 1 credit per copilot message (staff chat and admin
  // "View as Client" sessions are free). The charge enforces the balance +
  // weekly/monthly caps; denials return 402 with a readable message the dock
  // renders inline.
  let credits: ClientCredits | null = null;
  if (isBillableClientActor(user)) {
    try {
      await chargeClientCredits({
        clientId,
        amount: CREDIT_COSTS.chatMessage,
        operation: "chat_message",
        reason: "Copilot chat message",
        actorUid: user.uid,
        actorName: user.name,
      });
    } catch (e) {
      if (e instanceof CreditError) {
        return Response.json({ error: e.message }, { status: 402 });
      }
      throw e;
    }
    credits = await getClientCredits(clientId);
  }

  // WHOSE VOCABULARY THIS SESSION SPEAKS, asked once, for the whole handler.
  //
  // The route admits a CLIENT_USER for their own clientId and serves BOTH docks,
  // so every string composed below — the system prompt, the §3 tool results, the
  // deep links, the failure sentences — is client copy whenever this is true.
  // One binding, read by all of them, because the defect this closes was the
  // same question answered twice.
  //
  // WHAT "VIEW AS CLIENT" GETS, spelled out because the previous note here said
  // the opposite of what the code does. An impersonating admin arrives as
  // `role: "CLIENT_USER"` carrying `impersonatedBy` (auth.ts), `isStaffCopilotActor`
  // denies them on purpose, so `viewerIsClient` is TRUE and they get the CLIENT
  // register AND the CLIENT deep link — both, not one of each. That is the point
  // of the mode: they are looking at what the client sees. It is also the only
  // link that works for them, because `/jobs` guards on `requireUser(["KAROS_ADMIN",
  // "KAROS_EMPLOYEE"])` against `user.role` — which is CLIENT_USER in that session
  // — so a "helpfully" staff deep link would redirect them to /dashboard.
  //
  // Executed to confirm, not read off: role KAROS_ADMIN → viewerIsClient=false,
  // "Awaiting review", staff link; CLIENT_USER + impersonatedBy → true, "Draft",
  // client link; plain CLIENT_USER → true, "Draft", client link.
  //
  // The reschedule tool's write path calls `isStaffCopilotActor` again at its own
  // site. Same predicate, deliberately spelled out there, because it is asking a
  // different QUESTION of it — "may this session write staff-tier state?" rather
  // than "whose words do I use?" — and those two are allowed to diverge later.
  // What must not happen is a second ANSWER to either.
  const viewerIsClient = !isStaffCopilotActor(user);

  // Locked (future-dated) content never reaches a client-facing model prompt —
  // and neither does staff-only working material. Launch deliverables and
  // Control Room Test Run output are both undated (isAssetUnlockedForClient
  // trivially returns true for anything with no scheduledAt), so without this
  // they passed the lock check and a client could ask find_output/edit_output
  // to read or overwrite them — the exact "never reaches a client-facing
  // surface" guarantee those two flags exist to make (asset-visibility.ts).
  const promptAssets =
    user.role === "CLIENT_USER"
      ? assets.filter(
          (a) => isAssetUnlockedForClient(a, Date.now()) && !isLaunchDeliverable(a) && !isTestRunAsset(a),
        )
      : assets;
  // Same boundary for documents: internal-tier docs are analyst-grade copy that
  // types.ts restricts to admin/employee, and internal-only is never published —
  // neither may reach a prompt the client is talking to. Mirrors the asset filter
  // above rather than relying on the prompt builder's tier preference.
  const promptContextDocs =
    user.role === "CLIENT_USER" ? contextDocs.filter((d) => d.tier === "client") : contextDocs;
  const baseSystemPrompt = buildCopilotSystemPrompt(
    client,
    report,
    competitors,
    jobs,
    promptAssets,
    promptContextDocs,
    // Two separate questions, passed separately on purpose: which TOOLS to
    // describe, and whose VOCABULARY to write in. They happen to be the same
    // predicate today; folding them into one flag would mean a future change to
    // who may edit branding silently changed what words a client reads.
    { canUpdateBranding: !viewerIsClient, viewerIsClient },
  );

  /* ── Shared Google integration lookup ────────────────────────────── */
  // Gated on GRANTOR IDENTITY, not just usability. The `google` integration is
  // one row per WORKSPACE (`${clientId}_google`) written from one individual's
  // personal OAuth grant, and multi-seat workspaces are the norm — so resolving
  // it by platform alone handed user B user A's private inbox (and staff opening
  // that client's copilot got it too). `integrationBelongsToCaller` matches the
  // recorded grantor against the caller and fails closed when it cannot.
  //
  // Gating HERE rather than inside the tool is what makes the degraded path
  // indistinguishable from an unconnected workspace: `hasGmailIntegration` below
  // goes false as well, so the prompt's Scenario-D block is withheld and its
  // silence rule ("never mention email integration, Gmail, or inbox
  // connectivity") applies. So WITHIN THIS SESSION a non-grantor sees exactly
  // what an unconnected workspace looks like.
  //
  // Two honest limits on that, because an overstated guarantee is worse than a
  // stated one:
  //  - it is identity, not role. A staff member is normally not the grantor and
  //    so loses the scan — but a staff member who granted it themselves keeps
  //    it, correctly, because the mailbox is theirs.
  //  - it covers this route. The Integrations settings payload still carries
  //    `accountName` for every row (sanitizeIntegrations strips credentials, not
  //    that field), so the grantor's address is in that page's RSC payload even
  //    though no surface renders it. Narrowing that is a separate change.
  const googleIntegration = integrations.find(
    (i) =>
      i.platform === "google" &&
      integrationIsUsable(i) &&
      integrationBelongsToCaller(i, user.email),
  );

  // Build dynamic proactive appendix with the managed-product catalog (karos-agents
  // lab products run by the Karos team), social integrations, calendar state, and
  // Gmail status so the AI follows the correct scenario rules.
  // Unified roster: the managed lab products PLUS the client's assigned custom
  // agents (git-imported), so the copilot plans around the full agent set.
  const agentCatalog = buildAgentCatalog(customAgents);

  const socialIntegrations = integrations
    .filter((i) => i.platform !== "google")
    .map((i) => ({
      platform: i.platform,
      // The proactive appendix only knows active|expired; reauthenticate maps to expired.
      status: (integrationNeedsReconnect(i) ? "expired" : "active") as "active" | "expired",
    }));
  const linkedSocialPlatforms = socialIntegrations
    .filter((i) => i.status === "active")
    .map((i) => i.platform);

  const hasScheduledContent = assets.some((a) => a.status === "scheduled");

  // Live calendar state for content-gap detection: scheduled/approved items in
  // the next 14 days, bucketed by target platform — with a 7-day sub-bucket so
  // the prompt can flag a "covered this week, empty next week" cliff.
  const nowMs = Date.now();
  const week1Ms = nowMs + 7 * 24 * 60 * 60 * 1000;
  const horizonMs = nowMs + 14 * 24 * 60 * 60 * 1000;
  const scheduledNext14ByPlatform: Record<string, number> = {};
  const scheduledNext7ByPlatform: Record<string, number> = {};
  for (const a of assets) {
    if (a.scheduledAt == null || a.scheduledAt < nowMs || a.scheduledAt > horizonMs) continue;
    if (a.status !== "scheduled" && a.status !== "approved") continue;
    const key = a.scheduledPlatform ?? "unassigned";
    scheduledNext14ByPlatform[key] = (scheduledNext14ByPlatform[key] ?? 0) + 1;
    if (a.scheduledAt <= week1Ms) {
      scheduledNext7ByPlatform[key] = (scheduledNext7ByPlatform[key] ?? 0) + 1;
    }
  }

  // Make the copilot credits-aware for client users: it can quote run costs,
  // warn on a low balance, and explain why an action was declined.
  //
  // Custom agent runs are the dominant client spend and the only thing the
  // Agents page charges, yet neither they nor the employee seat appeared in
  // the price list the model is told never to go beyond — so it either
  // declined or quoted the 5-credit task baseline against a real 25 (QA F95).
  const agentPriceLines = customAgents
    .map((a) => `  - ${a.name}: ${a.creditCost ?? CREDIT_COSTS.customAgentRun} credits per run`)
    .join("\n");
  const creditsAppendix = credits
    ? `\n\n## Usage credits\n` +
      // The headline number is what the client can actually spend — balance
      // clipped by the weekly/monthly caps. Quoting the raw balance is the
      // same mistake F102 fixed on the rail, the panel and the agents page:
      // a capped client would be told a number they cannot spend.
      `This client pays for AI actions with credits. Spendable right now: ${availableCredits(credits)} credits — ` +
      `quote THIS figure when asked what they have; it is the balance already clipped by their spend caps. ` +
      `Used ${credits.weekSpent}${credits.weeklyLimit != null ? ` of ${credits.weeklyLimit}` : ""} this week, ` +
      `${credits.monthSpent}${credits.monthlyLimit != null ? ` of ${credits.monthlyLimit}` : ""} this month.\n` +
      `Costs: chat message ${CREDIT_COSTS.chatMessage}; task execution ${CREDIT_COSTS.taskExecution} baseline, or by product — ` +
      `blog article ${TASK_EXECUTION_COSTS.blog_article}, newsletter ${TASK_EXECUTION_COSTS.newsletter_issue}, ` +
      `social posts ${TASK_EXECUTION_COSTS.social_post}, landing page ${TASK_EXECUTION_COSTS.landing_page}; ` +
      `doc correction ${CREDIT_COSTS.targetedCorrection} (global ${CREDIT_COSTS.globalCorrection}).\n` +
      `AI agent runs (the Agents page) cost ${CREDIT_COSTS.customAgentRun} credits per run by default; some agents are priced individually. ` +
      (agentPriceLines
        ? `This client's agents and their exact prices:\n${agentPriceLines}\n`
        : `This client has no AI agents assigned yet.\n`) +
      `An extra LinkedIn employee-advocacy seat beyond the plan's limit costs ${CREDIT_COSTS.employeeSeat} credits, charged once — it is not a monthly subscription.\n` +
      `If spendable credits are under 20, proactively mention it and suggest asking the Karos team for a top-up. Never invent credit figures beyond these.`
    : "";

  // Provenance boundary, same shape as the asset and context-doc filters
  // above: mock analytics rows must never reach a prompt a CLIENT is talking
  // to. The benchmark block presents them as "measured results from this
  // client's published content", so the copilot will narrate invented figures
  // as fact — F125's blocker, on a surface the client is charged for. Staff
  // keep the full set; the demo data is theirs to see.
  // sampleSize is recomputed from the rows that survive (top and bottom can
  // overlap on a small set), so the "N tracked assets" claim can only
  // understate, never overstate.
  const promptBenchmarks = (() => {
    if (user.role !== "CLIENT_USER") return benchmarks;
    const top = benchmarks.top.filter((r) => r.source === "live");
    const bottom = benchmarks.bottom.filter((r) => r.source === "live");
    const distinct = new Set([...top, ...bottom].map((r) => r.id));
    return { top, bottom, sampleSize: distinct.size };
  })();

  // Flatten measured analytics into the prompt's benchmark shape (Firestore
  // types stay out of the pure prompt builder).
  const toBenchmarkEntry = (r: (typeof benchmarks.top)[number]) => ({
    label: r.assetLabel ?? r.assetId,
    platform: r.platform,
    assetType: r.assetType,
    engagementScore: r.engagementScore,
    impressions: r.metrics.impressions,
    engagementRate: r.metrics.engagementRate,
  });

  /* ── Agent feedback + @mention focus appendix ────────────────────── */
  // Both blocks read the SAME two builders `client-agent-feedback-context.ts`
  // already uses to attach `agent-feedback.md` to a run (renderFeedbackMarkdown
  // + listClientAgentFeedback) — this is a second CONSUMER of that data, not a
  // second write path or a second serialization.
  const feedbackByUmbrella = new Map(
    await Promise.all(
      liveUmbrellas.map(
        async (u) =>
          [u.id, await listClientAgentFeedback({ clientAgentId: u.id, status: "active" })] as const,
      ),
    ),
  );

  const agentFeedbackAppendix = (() => {
    const sections = liveUmbrellas
      .map((u) => renderFeedbackMarkdown({ agentName: u.displayName, rows: feedbackByUmbrella.get(u.id) ?? [], templates: u.templates }))
      .filter((md): md is string => md != null);
    if (sections.length === 0) return "";
    return `\n\n## AGENT FEEDBACK\nStanding feedback this client has already given on their live agents. Reference it when discussing an agent; do not repeat it verbatim unless asked.\n\n${sections.join("\n")}`;
  })();

  // `@mention` focus — set when the client picked an agent from the chat's
  // mention dropdown, or via set_agent_focus in plain text. A FOCUS, not a
  // hard scope: the model still answers anything else asked, but leads with
  // this agent's own context.
  //
  // Two id spaces, tried in order, both scoped to THIS client so a stale or
  // foreign id from the browser can't focus the prompt on another client's
  // agent: a LIVE umbrella's own id (richer identity — templates, feedback),
  // falling back to a bare custom-agent id for an agent this client has been
  // assigned but never launched (mentionable/route.ts hands that id out when
  // there's no umbrella to point at yet — see its own comment). The two
  // spaces never collide, so no prefix is needed to tell them apart.
  const focusUmbrella = body.focusAgentId
    ? liveUmbrellas.find((u) => u.id === body.focusAgentId)
    : undefined;
  const focusCatalogAgent =
    !focusUmbrella && body.focusAgentId
      ? customAgents.find((a) => a.id === body.focusAgentId)
      : undefined;
  const focusedAgent = focusUmbrella
    ? {
        customAgentId: focusUmbrella.customAgentId,
        displayName: focusUmbrella.displayName,
        templates: focusUmbrella.templates,
        feedbackRows: feedbackByUmbrella.get(focusUmbrella.id) ?? [],
      }
    : focusCatalogAgent
      ? {
          customAgentId: focusCatalogAgent.id,
          displayName: focusCatalogAgent.name,
          templates: [],
          feedbackRows: [],
        }
      : null;

  // Same "prefer the live umbrella's name" rule mentionable/route.ts uses, so
  // the names named in this prompt match what the client sees in the dropdown.
  const liveByCustomAgentId = new Map(liveUmbrellas.map((u) => [u.customAgentId, u]));
  const mentionableNames = customAgents.map((a) => liveByCustomAgentId.get(a.id)?.displayName ?? a.name);

  const focusAppendix = focusedAgent
    ? `\n\n## FOCUSED AGENT\nThe user is currently focused on **${focusedAgent.displayName}** — this STAYS active across turns ` +
      `until they explicitly ask to switch to a different agent or return to the general copilot; never drop it on your own. ` +
      `Prioritize this agent in your answers${focusedAgent.templates.length > 0 ? ` — its templates: ${focusedAgent.templates.map((t) => t.name).join(", ")}` : ""}. ` +
      `Still answer anything else they ask; this is a focus, not a restriction. ` +
      `If they ask (in plain text, not @mention) to switch to another agent or go back to general, call set_agent_focus.` +
      (() => {
        const md = renderFeedbackMarkdown({
          agentName: focusedAgent.displayName,
          rows: focusedAgent.feedbackRows,
          templates: focusedAgent.templates,
        });
        return md ? `\n\n${md}` : "";
      })()
    : mentionableNames.length > 0
      ? `\n\n## AGENT FOCUS\nNo agent is focused right now — you're the general copilot. If the user asks in plain text ` +
        `to talk to / focus on one of their agents (${mentionableNames.join(", ")}), call set_agent_focus ` +
        `to switch into it; it then stays focused across turns until they ask to switch again or return here.`
      : "";

  // Relative-date reasoning for `/reschedule-post` — `buildCopilotSystemPrompt`
  // already states "Today is <date>" in prose; this restates it as an
  // unambiguous ISO instant so a tool call's datetime input is computed from
  // the same instant the model reasons about, not re-derived from prose.
  const nowAppendix = `\n\n## CURRENT DATE/TIME\n${new Date().toISOString()} (UTC). Convert relative dates ("next Thursday", "in two weeks") from this instant.`;

  const systemPrompt =
    `${baseSystemPrompt}\n\n` +
    buildProactiveSystemAppendix({
      agents: agentCatalog,
      linkedSocialPlatforms,
      integrations: socialIntegrations,
      scheduledNext14ByPlatform,
      scheduledNext7ByPlatform,
      hasGmailIntegration: !!googleIntegration,
      hasScheduledContent,
      activeTaskCount: boardCapacity.activeCount,
      maxActiveTasks: MAX_ACTIVE_TASKS,
      historicalBenchmarks: {
        top: promptBenchmarks.top.map(toBenchmarkEntry),
        bottom: promptBenchmarks.bottom.map(toBenchmarkEntry),
        sampleSize: promptBenchmarks.sampleSize,
      },
    }) +
    creditsAppendix +
    agentFeedbackAppendix +
    focusAppendix +
    nowAppendix;

  /* ── Shared tools ─────────────────────────────────────────────────── */

  const updateBrandingTool = tool({
    description:
      "Update this client's branding guidelines. Call this when the user asks to change brand colors, fonts, or tone keywords. Only call after the user has confirmed the specific change.",
    inputSchema: z.object({
      primaryAccent: z.string().optional().describe("Main dominant brand accent color as a hex code e.g. #e91e8c"),
      secondaryAccent: z.string().optional().describe("Supporting contrast/action color as a hex code"),
      brandNeutralDark: z.string().optional().describe("Foundational dark shade (deep background or heavy text) as a hex code"),
      brandNeutralLight: z.string().optional().describe("Foundational light shade (crisp background or clean body text) as a hex code"),
      fontHeading: z.string().optional().describe("Heading font name e.g. Playfair Display"),
      fontBody: z.string().optional().describe("Body font name e.g. Inter"),
      toneKeywords: z
        .array(z.string())
        .optional()
        .describe("Complete list of brand tone keywords to set (replaces existing list)"),
      guidelines: z.string().optional().describe("Free-form written brand guidelines"),
    }),
    execute: async (args) => {
      // Defence in depth: copilotToolsFor already keeps this tool out of a
      // client session's registry, so reaching here means the filter was
      // bypassed. Refuse rather than write.
      const refusal = brandingToolRefusal(user);
      if (refusal) return refusal;

      const current: Partial<BrandingGuidelines> = client.brandingGuidelines ?? {};
      const updated: BrandingGuidelines = { ...current, updatedAt: Date.now() };
      if (args.primaryAccent !== undefined) updated.primaryAccent = args.primaryAccent;
      if (args.secondaryAccent !== undefined) updated.secondaryAccent = args.secondaryAccent;
      if (args.brandNeutralDark !== undefined) updated.brandNeutralDark = args.brandNeutralDark;
      if (args.brandNeutralLight !== undefined) updated.brandNeutralLight = args.brandNeutralLight;
      if (args.fontHeading !== undefined) updated.fontHeading = args.fontHeading;
      if (args.fontBody !== undefined) updated.fontBody = args.fontBody;
      if (args.toneKeywords !== undefined) updated.toneKeywords = args.toneKeywords;
      if (args.guidelines !== undefined) updated.guidelines = args.guidelines;
      await updateClient(clientId, { brandingGuidelines: updated });
      try {
        // Deterministic tier — matches the write in src/lib/branding.ts.
        const existingDoc = await getClientContextDoc(clientId, "branding-guidelines", "internal");
        await upsertClientContextDoc({
          clientId,
          docType: "branding-guidelines",
          tier: existingDoc?.tier ?? "internal",
          content: brandingToContextDocContent(updated, client.name),
          version: (existingDoc?.version ?? 0) + 1,
          sources: existingDoc?.sources,
          createdAt: existingDoc?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        });
      } catch (e) {
        // The structured field is saved but the context doc the AGENTS read is
        // now a version behind, which is exactly the divergence that produces
        // off-brand output later. Don't let the copilot report a clean success
        // — same honesty rule as the support-email tool above.
        console.error(
          `[copilot] Branding context doc sync failed for client ${clientId}:`,
          e,
        );
        return "Saved the branding guidelines, but the copy the content agents read didn't refresh - flag this to the Karos team so they can re-sync it.";
      }
      return "Branding guidelines updated successfully.";
    },
  });

  const sendSupportEmailTool = tool({
    description:
      "Send a support request email to the Karos Labs admin team on behalf of the client. Use when the user reports a problem, requests human help, or asks you to escalate an issue you cannot resolve.",
    inputSchema: z.object({
      subject: z.string().describe("Concise email subject line"),
      message: z.string().describe("Full message body summarising the issue or request clearly"),
    }),
    execute: async ({ subject, message }) => {
      const adminEmail = process.env.ADMIN_EMAIL;
      const emailHtml = `
        <p><strong>Client:</strong> ${client.name} (${clientId})</p>
        <p><strong>Submitted by:</strong> ${user.name ?? user.email}</p>
        <hr style="border:none;border-top:1px solid #20303a;margin:12px 0;" />
        <p><strong>Message:</strong></p>
        <p style="white-space:pre-wrap;">${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
      `;
      if (adminEmail) {
        const result = await sendEmail({
          to: adminEmail,
          subject: `[Copilot Support] ${subject}`,
          html: emailHtml,
          replyTo: user.email,
        });
        if (!result.ok) {
          // Don't let the copilot falsely claim success — log the real cause and
          // tell the model delivery failed so it can relay that honestly.
          console.error(
            `[copilot] Support email failed for client ${clientId}: ${result.error}`,
          );
          return "I couldn't send the support email just now — please try again shortly, or email hello@karoslabs.com directly.";
        }
      } else {
        console.log("[copilot] Support email (ADMIN_EMAIL not set):", { subject, message, clientId });
      }
      return "Support email sent to the Karos Labs team.";
    },
  });

  /* ── Proactive tool: fetch Gmail context ─────────────────────────── */

  const fetchGmailContextTool = tool({
    description:
      "Fetch recent unread business emails from the client's Gmail inbox and extract actionable task candidates using Claude Haiku. " +
      "Call when the user asks to scan their inbox, refresh their task map, or sync emails. " +
      "Do NOT call for any other purpose.",
    inputSchema: z.object({
      maxEmails: z.number().int().min(5).max(25).default(15).describe(
        "Maximum number of emails to retrieve (5–25).",
      ),
    }),
    execute: async ({ maxEmails }) => {
      // One branch, two reasons: no grant in this workspace, or a grant that is
      // not the caller's. They MUST stay one branch returning one string — a
      // separate message for the second case would disclose that someone else
      // connected their mail. Hence the shared constant, pinned by a test.
      if (!googleIntegration) {
        return GMAIL_UNAVAILABLE_MESSAGE;
      }

      const accessToken = googleIntegration.credentials.access_token;
      if (!accessToken) {
        return "Google access token missing. Please sign in with Google again to refresh your credentials.";
      }

      let emails;
      try {
        emails = await fetchGmailMessages(accessToken, maxEmails);
      } catch (err) {
        if (err instanceof GmailTokenExpiredError) {
          await markIntegrationExpired(clientId, "google").catch(() => {});
          if (err.reason === "insufficient_scope") {
            return (
              "Gmail access was denied - the gmail.readonly permission wasn't granted during sign-in, " +
              "or the Gmail API isn't enabled for this integration. " +
              "Please sign out and sign back in with Google, and make sure to approve the Gmail permission on the consent screen. " +
              "I can still work from your meetings and context documents in the meantime."
            );
          }
          return (
            "Your Google access token has expired. " +
            "Please sign out and sign back in with Google to restore Gmail access. " +
            "I can still build a task map from your existing context - just let me know."
          );
        }
        return "Failed to connect to Gmail. Check your network and try again.";
      }

      if (emails.length === 0) {
        return "No unread primary-inbox signals found. Your operational queue looks clear!";
      }

      // Run Claude Haiku to extract structured tasks from the operational signals
      const taskSchema = z.object({
        tasks: z.array(
          z.object({
            title: z.string().max(120),
            description: z.string().max(500),
            priority: z.enum(["high", "medium", "low"]),
            owner: z.enum(["karos_managed", "client_managed"]).default("karos_managed"),
          }),
        ),
      });

      const haiku = anthropic(MODELS.HAIKU);
      const extractionPrompt = buildGmailExtractionPrompt(
        emails,
        client.name,
        client.industry ?? "business",
      );

      const { object: extracted, usage: haikuUsage } = await generateObject({
        model: haiku,
        schema: taskSchema,
        prompt: extractionPrompt,
      });

      // Log Haiku token usage against this client
      after(() =>
        logger.logUsage({
          clientId,
          agentId: null,
          agentName: "proactive_signal_extractor",
          modelName: MODELS.HAIKU,
          operation: "operational_signal_extraction",
          inputTokens: haikuUsage.inputTokens ?? 0,
          outputTokens: haikuUsage.outputTokens ?? 0,
        }),
      );

      if (extracted.tasks.length === 0) {
        return `Analyzed ${emails.length} operational signals - no actionable items detected. Your queue looks clear for now.`;
      }

      // Three-tier dedup (task-dedup.ts) — Gmail candidates are title-only, so
      // the exact + near-identical-wording tiers apply.
      const { activeCount, tasks: boardTasks } = await getTaskBoardCapacity(clientId);
      const deduped = extracted.tasks.filter(
        (t) => findDuplicateReason({ title: t.title }, boardTasks) === null,
      );
      const dupSkipped = extracted.tasks.length - deduped.length;

      if (deduped.length === 0) {
        return `Analyzed ${emails.length} operational signals - all extracted items already exist in your task board (${dupSkipped} duplicate${dupSkipped !== 1 ? "s" : ""} skipped).`;
      }

      // The cap bounds the Karos AI execution queue only — client_managed
      // items pass through uncapped.
      const slotsFree = Math.max(0, MAX_ACTIVE_TASKS - activeCount);
      const karosProposed = deduped.filter((t) => t.owner === "karos_managed");
      const clientProposed = deduped.filter((t) => t.owner !== "karos_managed");
      const acceptedKaros = karosProposed.slice(0, slotsFree);
      const capSkipped = karosProposed.length - acceptedKaros.length;
      const freshTasks = [...clientProposed, ...acceptedKaros];

      if (freshTasks.length === 0) {
        return `Analyzed ${emails.length} operational signals and found ${deduped.length} actionable item${deduped.length !== 1 ? "s" : ""}, but the Karos-managed queue is at capacity (${MAX_ACTIVE_TASKS} active tasks). Complete or approve existing tasks, then re-scan.`;
      }

      const now = Date.now();
      await Promise.all(
        freshTasks.map((t) =>
          createClientTask({
            clientId,
            title: t.title,
            description: t.description,
            status: "pending",
            priority: t.priority as TaskPriority,
            source: "gmail" as TaskSource,
            owner: t.owner as TaskOwner,
            weight: { high: 80, medium: 50, low: 25 }[t.priority],
            sourceLabel: "Operational Intelligence",
            createdBy: user.uid,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );

      const notes = [
        dupSkipped > 0 ? `${dupSkipped} duplicate${dupSkipped !== 1 ? "s" : ""} skipped` : "",
        capSkipped > 0 ? `${capSkipped} deferred - Karos-managed queue capacity reached` : "",
      ].filter(Boolean);
      const skipNote = notes.length ? ` (${notes.join("; ")})` : "";
      return (
        `Analyzed ${emails.length} operational signals and created ${freshTasks.length} task${freshTasks.length !== 1 ? "s" : ""}${skipNote}:\n` +
        freshTasks.map((t, i) => `${i + 1}. [${t.priority.toUpperCase()}] ${t.title}`).join("\n")
      );
    },
  });

  /* ── Proactive tool: create tasks ────────────────────────────────── */

  const KNOWN_PRODUCT_TYPES = new Set(MANAGED_PRODUCTS.map((p) => p.taskType));
  // The client's allowlisted custom agents — assignable executors alongside
  // the managed products. Validated so the model can't invent an agentId.
  const customAgentsById = new Map(customAgents.map((a) => [a.id, a]));

  const createTasksTool = tool({
    description:
      "Persist one or more structured tasks to the client's task board after you have completed your analysis. " +
      "Call this AFTER writing your analysis response text, not before. " +
      "Use for competitor research, brand audits, content dispatch plans, or any other actionable output. " +
      "Set owner='karos_managed' for tasks Karos AI or staff will execute; 'client_managed' for tasks the client must do themselves. " +
      "Every karos_managed content task MUST name its executing agent: set productType for a managed product, OR agentId for a custom agent (from AVAILABLE AI EXECUTION AGENTS). Never set both. " +
      "Exception: if the user has @mentioned/focused one agent (see FOCUSED AGENT below), a karos_managed task with neither set defaults to that agent automatically. " +
      `The Karos AI execution queue holds at most ${MAX_ACTIVE_TASKS} active karos_managed tasks per client — karos_managed proposals beyond the free capacity are rejected; client_managed tasks are uncapped. ` +
      "Pass an empty tasks array when the board already covers all observable signals.",
    inputSchema: z.object({
      tasks: z
        .array(
          z.object({
            title: z.string().max(200).describe("Short, action-verb task title"),
            description: z.string().max(800).describe("Context and rationale for this task"),
            priority: z.enum(["high", "medium", "low"]),
            source: z
              .enum(["gmail", "competitor_research", "brand_audit", "content_dispatch", "copilot", "custom"])
              .describe("Which proactive action generated this task"),
            owner: z
              .enum(["karos_managed", "client_managed"])
              .describe("karos_managed = Karos AI/staff executes; client_managed = client must do it"),
            productType: z
              .enum(["social_post", "newsletter_issue", "blog_article", "landing_page"])
              .optional()
              .describe(
                "The MANAGED product (executing agent) for this task. Set for karos_managed content a managed product produces; omit when using agentId, for staff deliverables, and for client_managed tasks",
              ),
            agentId: z
              .string()
              .optional()
              .describe(
                "The id of a CUSTOM agent (from AVAILABLE AI EXECUTION AGENTS, marked 'custom agent') that will execute this task — use INSTEAD of productType when a custom agent fits. Must be an exact id from that list; never invented",
              ),
            platform: z
              .enum(["linkedin", "facebook", "instagram", "twitter", "youtube", "tiktok"])
              .optional()
              .describe("Canonical platform key the task concerns (integration onboarding, re-auth, or the content's target channel)"),
            weight: z
              .number()
              .int()
              .min(0)
              .max(100)
              .optional()
              .describe("Contextual priority weight per CONTEXTUAL PRIORITY SCORING — how critical the underlying gap is"),
          }),
        )
        // Room for a full Scan & Refresh in ONE call: up to 6 "depending on
        // you" onboarding/re-auth tasks PLUS the product sweep and signal
        // tasks — with 10 they competed and onboarding tasks were dropped.
        // The karos_managed cap is enforced separately below; client_managed
        // tasks are uncapped.
        .max(20),
    }),
    execute: async ({ tasks }) => {
      if (tasks.length === 0) {
        return "No new tasks created - the task board already covers all observable signals.";
      }

      // @mention default (§3): a karos_managed task with no executor named
      // while the chat is FOCUSED on one agent is presumed to be for that
      // agent — directing tasks to the agent the client tagged is the whole
      // point of picking it. Only fills the gap; the model's own
      // agentId/productType, when given, always wins.
      const withFocusDefault = focusedAgent
        ? tasks.map((t) =>
            t.owner === "karos_managed" && !t.agentId && !t.productType
              ? { ...t, agentId: focusedAgent.customAgentId }
              : t,
          )
        : tasks;

      // Three-tier dedup (task-dedup.ts): exact normalized title vs ALL
      // statuses, near-identical wording vs active tasks, and same
      // productType+platform scope within the same week. Accepted proposals
      // join the pool so a batch can't duplicate itself either.
      const { activeCount, tasks: boardTasks } = await getTaskBoardCapacity(clientId);
      const pool = [...boardTasks];
      const freshTasks: typeof withFocusDefault = [];
      const dupReasons: string[] = [];
      // Single pass: dedup and the karos cap decide together, and ONLY tasks
      // that will actually be created join the dedup pool — a cap-dropped
      // proposal must not shadow a later candidate as its "duplicate".
      // The cap bounds the Karos AI execution queue only; client_managed
      // tasks (onboarding, approvals) pass through uncapped.
      let karosSlotsFree = Math.max(0, MAX_ACTIVE_TASKS - activeCount);
      let capSkipped = 0;
      for (const t of withFocusDefault) {
        // Only an agentId the client actually has is a real executor link.
        const validCustomAgentId =
          t.agentId && customAgentsById.has(t.agentId) ? t.agentId : undefined;
        const reason = findDuplicateReason(
          { title: t.title, productType: t.productType, customAgentId: validCustomAgentId, platform: t.platform },
          pool,
        );
        if (reason) {
          dupReasons.push(`"${t.title}" - ${reason}`);
          continue;
        }
        if (t.owner === "karos_managed") {
          if (karosSlotsFree <= 0) {
            capSkipped++;
            continue;
          }
          karosSlotsFree--;
        }
        freshTasks.push(t);
        pool.push({
          id: `pending-${freshTasks.length}`,
          clientId,
          title: t.title,
          status: "pending",
          priority: t.priority as TaskPriority,
          source: t.source as TaskSource,
          owner: t.owner as TaskOwner,
          metadata: { productType: t.productType, customAgentId: validCustomAgentId, platform: t.platform },
          createdBy: user.uid,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      const dupSkipped = dupReasons.length;

      if (freshTasks.length === 0) {
        if (capSkipped > 0 && dupSkipped === 0) {
          return `Karos-managed queue is at capacity (${MAX_ACTIVE_TASKS} active tasks) - no tasks created. Ask the user to complete or approve existing tasks first.`;
        }
        return `No tasks created - ${capSkipped > 0 ? `${capSkipped} blocked by the Karos queue capacity and ` : ""}the rest duplicate existing work:\n${dupReasons.join("\n")}`;
      }

      const now = Date.now();
      await Promise.all(
        freshTasks.map((t) => {
          // Execution + sync linkage: productType / customAgentId route the
          // task to its executing agent; completionTrigger lets background
          // work (an integration connect, an independent product run) flip the
          // task automatically. A custom agent wins when both are supplied.
          const metadata: Record<string, unknown> = {};
          const linkedCustomAgent =
            t.owner === "karos_managed" && t.agentId ? customAgentsById.get(t.agentId) : undefined;
          if (linkedCustomAgent) {
            metadata.customAgentId = linkedCustomAgent.id;
            metadata.agentName = linkedCustomAgent.name;
          } else if (t.owner === "karos_managed" && t.productType && KNOWN_PRODUCT_TYPES.has(t.productType)) {
            metadata.productType = t.productType;
            metadata.completionTrigger = `product_run:${t.productType}`;
          }
          if (t.platform) {
            metadata.platform = t.platform;
            if (t.owner === "client_managed" && /connect|re-?auth/i.test(t.title)) {
              metadata.completionTrigger = `integration_connected:${t.platform}`;
            }
          }
          const weightDefault = { high: 80, medium: 50, low: 25 }[t.priority];
          return createClientTask({
            clientId,
            title: t.title,
            description: t.description,
            status: "pending",
            priority: t.priority as TaskPriority,
            source: t.source as TaskSource,
            owner: t.owner as TaskOwner,
            weight: t.weight ?? weightDefault,
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            createdBy: user.uid,
            createdAt: now,
            updatedAt: now,
          });
        }),
      );

      const count = freshTasks.length;
      const notes = [
        dupSkipped > 0 ? `${dupSkipped} duplicate${dupSkipped !== 1 ? "s" : ""} skipped` : "",
        capSkipped > 0 ? `${capSkipped} karos_managed dropped - AI queue capacity (${MAX_ACTIVE_TASKS} active) reached` : "",
      ].filter(Boolean);
      const skipNote = notes.length ? ` (${notes.join("; ")})` : "";
      return `Created ${count} task${count !== 1 ? "s" : ""} in your task board${skipNote}.`;
    },
  });

  /* ── Capability-matrix tools (§3): lookup, edit, run, reschedule, feedback ── */

  /**
   * One deep link per viewer role, resolved server-side (redaction-at-the-
   * boundary, same doctrine every other projection on this route follows).
   * Staff get the exact per-job route (`/jobs/{id}`) when one exists, or the
   * agent page with `?asset=` (OutputsHub auto-opens the modal from it).
   * Clients never get `/jobs` or `/assets` — both redirect a CLIENT_USER away
   * — so they get the agent detail page they actually have, or the Workspace
   * as a last resort.
   */
  // `viewerIsClient` is bound once, near the top of this handler, and decides
  // BOTH the link below and the register the §3 tools speak in — see the note
  // there for what "View as Client" gets and why.

  // Arrow expression, not a function declaration — narrowing `user` to
  // non-null (the route's early `if (!user...) return` above) does not
  // survive into a hoisted `function` declaration's body, only into a
  // closure, which is also why every tool below is defined the same way.
  const deepLinkForAsset = (asset: Asset): string => {
    const job = asset.jobId ? (jobs.find((j) => j.id === asset.jobId) ?? null) : null;
    const identity = resolveContentIdentity({ asset, job }, umbrellas as ClientAgentIdentity[]);
    const umbrella = identity.clientAgentId
      ? umbrellas.find((u) => u.id === identity.clientAgentId)
      : undefined;
    if (!viewerIsClient) {
      if (job) return `/jobs/${job.id}`;
      if (umbrella) return `/clients/${clientId}/agents/${umbrella.customAgentId}?asset=${asset.id}`;
      return `/assets?clientId=${clientId}`;
    }
    if (umbrella) return `/clients/${clientId}/agents/${umbrella.customAgentId}`;
    return "/tasks";
  };

  /**
   * The publish state of one output, as the ACTOR reading it is told it.
   *
   * Tool text is copy. The model paraphrases whatever this returns straight
   * back into the dock, so an interpolated `asset.status` here reaches a client
   * as prose in any wording the model likes ("status: scheduled") — the same
   * defect the rendered badges had, one indirection out, and not one a render
   * gate can catch. Sanitizing at the boundary means the enum is absent from
   * what the model is given, rather than present and hopefully rephrased.
   *
   * `find_output` is on the client allowlist (copilot-tool-access) and the
   * route's own gate only checks WHICH client's assets a caller may reach, so
   * the viewer is the one thing this cannot take as a constant.
   */
  const statusLabelForActor = (status: Asset["status"]): string =>
    assetStatusLabel(status, viewerIsClient);

  const findOutputTool = tool({
    description:
      "Look up one of this client's own generated outputs (assets) by id or a fragment of its title. " +
      "Call this BEFORE edit_output, reschedule_output, or when the user asks about the status of something specific — you need the exact id first.",
    inputSchema: z.object({
      query: z.string().describe("An asset id, or part of its title"),
    }),
    execute: async ({ query }) => {
      const trimmed = query.trim();
      if (!trimmed) return "Give me an id or part of a title to search for.";
      const byId = promptAssets.find((a) => a.id === trimmed);
      const matches = byId
        ? [byId]
        : promptAssets.filter((a) => (a.title ?? "").toLowerCase().includes(trimmed.toLowerCase()));
      if (matches.length === 0) return `No output found matching "${query}".`;
      if (matches.length > 1) {
        const top = matches.slice(0, 5);
        return (
          `Found ${matches.length} matching outputs — which one did you mean?\n` +
          top
            .map((a) => `- "${a.title || "Untitled"}" (${statusLabelForActor(a.status)}) — id: ${a.id}`)
            .join("\n")
        );
      }
      const asset = matches[0];
      const rawContent = asset.content ?? "";
      const content = rawContent.slice(0, 4000);
      return [
        `**${asset.title || "Untitled"}** — status: ${statusLabelForActor(asset.status)}` +
          (asset.scheduledAt ? `, scheduled for ${new Date(asset.scheduledAt).toISOString()}` : ""),
        `id: ${asset.id}`,
        "",
        content + (rawContent.length > 4000 ? "\n[…truncated]" : ""),
        "",
        `[View this output](${deepLinkForAsset(asset)})`,
      ].join("\n");
    },
  });

  const editOutputTool = tool({
    description:
      "Save a revised version of one of this client's own generated outputs. Look it up with find_output first, " +
      "draft the full replacement text yourself based on what the user asked to change (not a diff — the complete new content), then call this.",
    inputSchema: z.object({
      assetId: z.string().describe("Exact asset id from find_output"),
      newContent: z.string().describe("The complete replacement content"),
      newTitle: z.string().optional(),
    }),
    execute: async ({ assetId, newContent, newTitle }) => {
      const existing = promptAssets.find((a) => a.id === assetId);
      if (!existing) return "I don't have that output — look it up with find_output first.";
      try {
        await updateAssetAction(assetId, { content: newContent, ...(newTitle ? { title: newTitle } : {}) });
      } catch (e) {
        // SANITIZED AT THE BOUNDARY, because this string is payload: the model
        // paraphrases whatever the tool returns back into the client's dock, so
        // the exception itself is what has to be absent — not merely unrendered.
        //
        // What was going out: `updateAssetAction` throws bare internal words
        // ("Unauthorized", "Forbidden", "Asset not found") and, underneath it,
        // whatever the Admin SDK throws. Executed with Firebase unconfigured, a
        // CLIENT read back "Couldn't save that: Firebase Admin is not configured.
        // Provide FIREBASE_SERVICE_ACCOUNT_KEY, the discrete FIREBASE_* vars, or
        // Application Default Credentials with FIREBASE_PROJECT_ID set." — env var
        // names and credential mechanisms, in a chat panel. This is #121's defect
        // (raw internal failure text to a client) in the one channel #121 did not
        // look at, and no render gate can catch it.
        //
        // STAFF KEEP THE REAL ERROR: they are the ones who fix it, and a staff dock
        // is the fastest place to see it. A client's copy is one sentence that
        // promises nothing the code cannot keep.
        //
        // The client path LOGS the real cause, so sanitizing does not also destroy
        // the only trace — otherwise every client-side save failure becomes
        // invisible, which is a worse outcome than the leak.
        if (viewerIsClient) {
          console.error(`[copilot] edit_output failed for client ${clientId}, asset ${assetId}:`, e);
          return CLIENT_SAVE_REFUSAL_MESSAGE;
        }
        return `Couldn't save that: ${e instanceof Error ? e.message : "unknown error"}.`;
      }
      return `Saved. [View this output](${deepLinkForAsset(existing)})`;
    },
  });

  const runAgentNowTool = tool({
    description:
      "Trigger an ad-hoc run of one of this client's custom agents right now, billed at its normal per-run rate. " +
      "Match agentQuery against AVAILABLE AI EXECUTION AGENTS. Confirm with the user before calling — this spends credits.",
    inputSchema: z.object({
      agentQuery: z.string().describe("The agent's name"),
      prompt: z.string().optional().describe("Optional extra instruction for this run"),
    }),
    execute: async ({ agentQuery, prompt }) => {
      const q = agentQuery.trim().toLowerCase();
      const match = customAgents.find((a) => a.name.toLowerCase().includes(q));
      if (!match) {
        return customAgents.length > 0
          ? `I couldn't match "${agentQuery}" to one of this client's agents. Available: ${customAgents.map((a) => a.name).join(", ")}.`
          : "This client has no AI agents assigned yet.";
      }
      const result = await runCustomAgentAction({
        agentId: match.id,
        clientId,
        prompt: prompt?.trim() || "Run requested via Copilot chat.",
      });
      if (result.error) {
        // REUSED, not re-answered: `clientSafeRunError` is exactly this shape (a
        // run that would not start) and already passes setup refusals and credit
        // denials through verbatim, which are the two things a client here DOES
        // need to read.
        //
        // Applied again at this boundary even though `runCustomAgentAction`
        // sanitizes internally, because it does so behind `isBillableClientActor`
        // — which EXCLUDES an impersonating admin, so "View as Client" was shown
        // the raw config error and did not see what the client sees. Two
        // predicates, two answers; the boundary asks the one that governs
        // vocabulary. Idempotent: the generic sentence is not on the allowlist, so
        // re-sanitizing it returns the same sentence.
        return viewerIsClient
          ? clientSafeRunError(result.error)
          : `Couldn't start that run: ${result.error}`;
      }
      return `Started a run of **${match.name}** — it takes 10–20 minutes, and your Karos team reviews the result before it reaches your Workspace.`;
    },
  });

  const rescheduleOutputTool = tool({
    description:
      "Move the publish date/time of one of this client's own already-approved or scheduled outputs. " +
      "Look it up with find_output first. Give the new time as ISO 8601, computed from CURRENT DATE/TIME above. " +
      "Refuses on a draft/in-review output, a time in the past, or a same-day collision with another post in the same content family.",
    inputSchema: z.object({
      assetId: z.string().describe("Exact asset id from find_output"),
      newScheduledAt: z.string().describe("New publish date/time, ISO 8601 (e.g. 2026-08-06T13:00:00.000Z)"),
    }),
    execute: async ({ assetId, newScheduledAt }) => {
      const parsed = Date.parse(newScheduledAt);
      if (Number.isNaN(parsed)) {
        return "That date didn't parse — give it as ISO 8601, e.g. 2026-08-06T13:00:00.000Z.";
      }
      // Real (non-impersonated) staff get the full-power path — no day/status
      // guard rails, since that surface is already theirs via the Assets UI.
      // A client session (including an admin impersonating one) gets the
      // scoped action instead: own asset, approved/scheduled only, date only.
      if (isStaffCopilotActor(user)) {
        try {
          const asset = await getAsset(assetId);
          if (!asset) return "Couldn't find that output.";
          await scheduleAssetAction(assetId, parsed, asset.scheduledPlatform, asset.publishMode);
        } catch (e) {
          // NOT sanitized, and that is correct rather than an oversight: this
          // branch is inside `isStaffCopilotActor(user)`, so only a real
          // (non-impersonated) staff account can reach it. Staff are owed the
          // exception.
          return `Couldn't reschedule: ${e instanceof Error ? e.message : "unknown error"}.`;
        }
        return `Moved to ${new Date(parsed).toISOString()}.`;
      }
      // The CLIENT path, and it DOES need a sanitizer — an earlier version of the
      // comment above certified it as safe because every *refusal* the action
      // composes is client copy. True, and not the whole story: the action opens
      // with `requireAssetAccess`, which THROWS bare "Unauthorized" / "Asset not
      // found" / "Forbidden" rather than returning a refusal. Uncaught, the AI SDK
      // hands the throw straight to a client's model, which paraphrases it.
      //
      // Returned refusals still pass through verbatim — those are written for this
      // reader. Only the throws are collapsed.
      try {
        const result = await clientRescheduleAssetAction(assetId, parsed);
        if (!result.ok) return result.error;
      } catch (e) {
        console.error("[copilot] reschedule_output threw for a client", e);
        return CLIENT_SAVE_REFUSAL_MESSAGE;
      }
      return `Moved to ${new Date(parsed).toISOString()}.`;
    },
  });

  const provideFeedbackTool = tool({
    description:
      "Record standing feedback on one of this client's LIVE agents — tone, formatting, or topic preferences that should " +
      "shape everything it makes from here on (or one format only, if scoped to a template). This is not a one-off request: " +
      "it's injected into every future run of that agent.",
    inputSchema: z.object({
      agentQuery: z.string().describe("The agent's name, matched against this client's live agents"),
      text: z.string().describe("The feedback itself, in the client's own words"),
      scope: z.enum(["agent", "template"]).default("agent"),
      templateKey: z.string().optional().describe("Required when scope is 'template' — one of the agent's own format keys"),
      category: z.enum(FEEDBACK_CATEGORIES as [string, ...string[]]).optional(),
    }),
    execute: async ({ agentQuery, text, scope, templateKey, category }) => {
      const q = agentQuery.trim().toLowerCase();
      const umbrella = liveUmbrellas.find((u) => u.displayName.toLowerCase().includes(q));
      if (!umbrella) {
        return liveUmbrellas.length > 0
          ? `I couldn't match "${agentQuery}" to one of this client's live agents. Live agents: ${liveUmbrellas.map((u) => u.displayName).join(", ")}.`
          : "This client has no live agents to give feedback on yet.";
      }
      const result = await addClientAgentFeedbackAction({
        clientId,
        clientAgentId: umbrella.id,
        scope,
        ...(scope === "template" ? { templateKey } : {}),
        text,
        ...(category ? { category } : {}),
      });
      if (result.error) return result.error;
      return `Saved — this ${
        scope === "template" ? `shapes only "${templateKey}" posts` : `applies to everything ${umbrella.displayName} makes`
      } from here on.`;
    },
  });

  /**
   * Plain-text half of the `@mention` focus. Picking `@AgentName` in the input
   * sets it client-side instantly, with no model turn — this tool exists for
   * the OTHER way in: "let's talk about my Instagram agent" / "switch to the
   * LinkedIn agent" / "go back to the general copilot", typed as a sentence
   * instead of the mention chip.
   *
   * The client holds `focusAgentId` in its own state (sent back on every
   * turn) — there is no other channel from server to client mid-stream, so
   * the change rides inside a plain HTML comment in the reply text:
   * `<!-- COPILOT_FOCUS:{...} -->`. `stripPipelineMarkers` (doc-render.ts)
   * already strips every HTML comment before render — the SAME mechanism the
   * brand-sync block already relies on to stay invisible — so this needs no
   * new rendering code; the client only needs to sniff the raw stream for it
   * (chatbot-widget.tsx) before the marker is stripped away.
   */
  const setAgentFocusTool = tool({
    description:
      "Switch which agent this conversation is focused on, or return to the general copilot. Call this when the user asks " +
      "IN PLAIN TEXT (not via the @mention picker) to talk to/focus on a specific agent, to switch to a different one, or to " +
      "stop focusing / go back to the general copilot. Matches against ALL of this client's agents, not only live ones. " +
      "Once focused, it stays focused across turns until they ask again — never call action='clear' unasked.",
    inputSchema: z.object({
      action: z.enum(["focus", "clear"]),
      agentQuery: z.string().optional().describe("Required when action is 'focus' — the agent's name"),
    }),
    execute: async ({ action, agentQuery }) => {
      if (action === "clear") {
        return "Back to the general copilot — I'm not focused on a specific agent anymore.\n\n<!-- COPILOT_FOCUS:null -->";
      }
      const q = (agentQuery ?? "").trim().toLowerCase();
      if (!q) return "Which agent would you like to focus on?";
      // Same two-id-space resolution as body.focusAgentId above: a live
      // umbrella's own id first (richer identity), else the bare custom-agent
      // id for an assigned agent that has never been launched.
      const umbrellaMatch = liveUmbrellas.find((u) => u.displayName.toLowerCase().includes(q));
      const catalogMatch = umbrellaMatch ? undefined : customAgents.find((a) => a.name.toLowerCase().includes(q));
      const resolved = umbrellaMatch
        ? { id: umbrellaMatch.id, name: umbrellaMatch.displayName }
        : catalogMatch
          ? { id: catalogMatch.id, name: catalogMatch.name }
          : null;
      if (!resolved) {
        return mentionableNames.length > 0
          ? `I couldn't match "${agentQuery}" to one of this client's agents. Available: ${mentionableNames.join(", ")}.`
          : "This client has no agents to focus on yet.";
      }
      const payload = JSON.stringify(resolved);
      return (
        `Switched focus to **${resolved.name}** — I'll prioritize it until you ask to focus on a different agent ` +
        `or go back to general.\n\n<!-- COPILOT_FOCUS:${payload} -->`
      );
    },
  });

  /* ── onFinish: log copilot token usage ───────────────────────────── */

  function logCopilotUsage(usage: { inputTokens?: number; outputTokens?: number }) {
    after(() =>
      logger.logUsage({
        clientId,
        agentId: null,
        agentName: "chat_copilot",
        modelName: modelId,
        operation: "chat_copilot",
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      }),
    );
  }

  /* ── Stream ──────────────────────────────────────────────────────── */

  const result = streamText({
    model: MODEL,
    system: systemPrompt,
    messages,
    stopWhen: STOP_WHEN,
    // Staff-only write tools are removed from a client session's registry
    // entirely — an unlisted tool cannot be called. See copilot-tool-access.ts.
    tools: copilotToolsFor(user, {
      update_branding_guidelines: updateBrandingTool,
      send_support_email: sendSupportEmailTool,
      fetch_gmail_context: fetchGmailContextTool,
      create_tasks: createTasksTool,
      find_output: findOutputTool,
      edit_output: editOutputTool,
      run_agent_now: runAgentNowTool,
      reschedule_output: rescheduleOutputTool,
      provide_feedback: provideFeedbackTool,
      set_agent_focus: setAgentFocusTool,
    }),
    onFinish: ({ usage }) => logCopilotUsage(usage),
  });

  return result.toTextStreamResponse();
}
