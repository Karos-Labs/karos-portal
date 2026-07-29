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
  isStaffCopilotActor,
} from "@/lib/copilot-tool-access";
import { isAssetUnlockedForClient } from "@/lib/post-chain";
import { buildProactiveSystemAppendix, buildGmailExtractionPrompt } from "@/lib/ai/prompts/proactive-assistant";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import { getClientCustomAgents, buildAgentCatalog } from "@/lib/agent-roster";
import { integrationIsUsable, integrationNeedsReconnect } from "@/lib/integration-status";
import { sendEmail } from "@/lib/email";
import { brandingToContextDocContent } from "@/lib/branding";
import { fetchGmailMessages, GmailTokenExpiredError } from "@/lib/integrations/gmail";
import { logger } from "@/services/logger";
import type { BrandingGuidelines, TaskOwner, TaskSource, TaskPriority } from "@/lib/types";
import { MODELS, MAX_ACTIVE_TASKS } from "@/lib/constants";

export const maxDuration = 60;

const MODEL = anthropic(MODELS.SONNET);
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
  };
  const messages = (body.messages ?? []) as ModelMessage[];

  const [client, report, competitors, contextDocs, jobs, assets, integrations, boardCapacity, benchmarks, customAgents] =
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
    ]);

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

  // Locked (future-dated) content never reaches a client-facing model prompt.
  const promptAssets =
    user.role === "CLIENT_USER" ? assets.filter((a) => isAssetUnlockedForClient(a, Date.now())) : assets;
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
    { canUpdateBranding: isStaffCopilotActor(user) },
  );

  /* ── Shared Google integration lookup ────────────────────────────── */
  const googleIntegration = integrations.find(
    (i) => i.platform === "google" && integrationIsUsable(i),
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
    creditsAppendix;

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
          return "I couldn't send the support email just now - please try again shortly, or email hello@karoslabs.com directly.";
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
      if (!googleIntegration) {
        return (
          "No Google Workspace integration found for this account. " +
          "To enable Gmail scanning, sign in with Google via the Login page (or Integrations tab) - " +
          "you will be prompted to grant Gmail read access. " +
          "In the meantime, I can still build a task map from your meetings and context documents."
        );
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

      // Three-tier dedup (task-dedup.ts): exact normalized title vs ALL
      // statuses, near-identical wording vs active tasks, and same
      // productType+platform scope within the same week. Accepted proposals
      // join the pool so a batch can't duplicate itself either.
      const { activeCount, tasks: boardTasks } = await getTaskBoardCapacity(clientId);
      const pool = [...boardTasks];
      const freshTasks: typeof tasks = [];
      const dupReasons: string[] = [];
      // Single pass: dedup and the karos cap decide together, and ONLY tasks
      // that will actually be created join the dedup pool — a cap-dropped
      // proposal must not shadow a later candidate as its "duplicate".
      // The cap bounds the Karos AI execution queue only; client_managed
      // tasks (onboarding, approvals) pass through uncapped.
      let karosSlotsFree = Math.max(0, MAX_ACTIVE_TASKS - activeCount);
      let capSkipped = 0;
      for (const t of tasks) {
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

  /* ── onFinish: log copilot token usage ───────────────────────────── */

  function logCopilotUsage(usage: { inputTokens?: number; outputTokens?: number }) {
    after(() =>
      logger.logUsage({
        clientId,
        agentId: null,
        agentName: "chat_copilot",
        modelName: MODELS.SONNET,
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
    }),
    onFinish: ({ usage }) => logCopilotUsage(usage),
  });

  return result.toTextStreamResponse();
}
