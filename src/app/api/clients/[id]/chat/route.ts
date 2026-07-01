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
  listAgents,
  listJobs,
  listAssets,
  listClientTasks,
  updateClient,
  updateAsset,
  upsertClientContextDoc,
  getClientContextDoc,
  listClientIntegrations,
  markIntegrationExpired,
  createClientTask,
  deleteAllClientTasks,
  normalizeTitleForDedup,
} from "@/lib/data";
import { buildCopilotSystemPrompt, buildAgentCopilotSystemPrompt } from "@/lib/copilot-context";
import { buildProactiveSystemAppendix, buildGmailExtractionPrompt } from "@/lib/ai/prompts/proactive-assistant";
import { startAgentRun } from "@/lib/agents/run";
import { sendEmail } from "@/lib/email";
import { brandingToContextDocContent } from "@/lib/branding";
import { fetchGmailMessages, GmailTokenExpiredError } from "@/lib/integrations/gmail";
import { logger } from "@/services/logger";
import type { Agent, Asset, BrandingGuidelines, TaskOwner, TaskSource, TaskPriority } from "@/lib/types";
import { MODELS } from "@/lib/constants";

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
    agentId?: string | null;
  };
  const messages = (body.messages ?? []) as ModelMessage[];
  const requestedAgentId = body.agentId ?? null;

  const [client, report, competitors, contextDocs, allAgents, jobs, assets, integrations] =
    await Promise.all([
      getClient(clientId),
      getClientReport(clientId),
      listClientCompetitors(clientId),
      listClientContextDocs(clientId),
      listAgents({ status: "published" }),
      listJobs({ clientId }),
      listAssets({ clientId }),
      listClientIntegrations(clientId),
    ]);

  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  // Resolve agent-specific mode
  let focusedAgent: Agent | null = null;
  let agentJobs = jobs;
  let agentAssets: Asset[] = [];

  if (requestedAgentId) {
    focusedAgent = allAgents.find((a) => a.id === requestedAgentId && !a.isSystem) ?? null;
    if (focusedAgent) {
      agentJobs = jobs.filter((j) => j.agentId === requestedAgentId);
      agentAssets = assets.filter((a) => a.agentId === requestedAgentId);
    }
  }

  const baseSystemPrompt = focusedAgent
    ? buildAgentCopilotSystemPrompt(focusedAgent, client, agentJobs, agentAssets, contextDocs)
    : buildCopilotSystemPrompt(client, report, competitors, allAgents, jobs, assets, contextDocs);

  /* ── Shared Google integration lookup ────────────────────────────── */
  const googleIntegration = integrations.find(
    (i) => i.platform === "google" && i.status === "active",
  );

  // Build dynamic proactive appendix with live agent catalog, social integrations,
  // calendar state, and Gmail status so the AI follows the correct scenario rules.
  const agentCatalog = allAgents
    .filter((a) => !a.isSystem && a.isActive && a.status === "published")
    .map((a) => ({
      id: a.id,
      name: a.name,
      outputKind: a.outputKind,
      description: a.description,
      capabilities: a.capabilities as string[],
    }));

  const linkedSocialPlatforms = integrations
    .filter((i) => i.platform !== "google" && (i.status ?? "active") === "active")
    .map((i) => i.platform);

  const hasScheduledContent = assets.some((a) => a.status === "scheduled");

  const systemPrompt =
    `${baseSystemPrompt}\n\n` +
    buildProactiveSystemAppendix({
      agents: agentCatalog,
      linkedSocialPlatforms,
      hasGmailIntegration: !!googleIntegration,
      hasScheduledContent,
    });

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
        const existingDoc = await getClientContextDoc(clientId, "branding-guidelines");
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
      } catch {
        // Non-fatal
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
        await sendEmail({
          to: adminEmail,
          subject: `[Copilot Support] ${subject}`,
          html: emailHtml,
          replyTo: user.email,
        });
      } else {
        console.log("[copilot] Support email (ADMIN_EMAIL not set):", { subject, message, clientId });
      }
      return "Support email sent to the Karos Labs team.";
    },
  });

  /* ── Proactive tool: purge task board ───────────────────────────── */

  const purgeTaskBoardTool = tool({
    description:
      "Delete ALL existing tasks in the client's task board to create a clean slate before a Scan & Refresh. " +
      "Call this ONLY at the very start of Action 1 (Scan & Refresh Task Map), before any other tools. " +
      "Do NOT call for competitor research, brand audits, or content dispatch actions.",
    inputSchema: z.object({}),
    execute: async () => {
      const deleted = await deleteAllClientTasks(clientId);
      return deleted > 0
        ? `Task board cleared — ${deleted} stale task${deleted !== 1 ? "s" : ""} removed. Generating fresh task map now.`
        : "Task board was already empty. Generating fresh task map now.";
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
          "To enable Gmail scanning, sign in with Google via the Login page (or Integrations tab) — " +
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
              "Gmail access was denied — the gmail.readonly permission wasn't granted during sign-in, " +
              "or the Gmail API isn't enabled for this integration. " +
              "Please sign out and sign back in with Google, and make sure to approve the Gmail permission on the consent screen. " +
              "I can still work from your meetings and context documents in the meantime."
            );
          }
          return (
            "Your Google access token has expired. " +
            "Please sign out and sign back in with Google to restore Gmail access. " +
            "I can still build a task map from your existing context — just let me know."
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
        return `Analyzed ${emails.length} operational signals — no actionable items detected. Your queue looks clear for now.`;
      }

      // Dedup against ALL existing tasks (every status: pending, in_progress,
      // review_pending, completed) so we never recreate work that is already
      // tracked or was recently finished.
      const existingTasks = await listClientTasks({ clientId, limit: 500 });
      const existingNorm = new Set(existingTasks.map((t) => normalizeTitleForDedup(t.title)));
      const freshTasks = extracted.tasks.filter(
        (t) => !existingNorm.has(normalizeTitleForDedup(t.title)),
      );
      const skipped = extracted.tasks.length - freshTasks.length;

      if (freshTasks.length === 0) {
        return `Analyzed ${emails.length} operational signals — all extracted items already exist in your task board (${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped).`;
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
            sourceLabel: "Operational Intelligence",
            createdBy: user.uid,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );

      const skipNote = skipped > 0 ? ` (${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped)` : "";
      return (
        `Analyzed ${emails.length} operational signals and created ${freshTasks.length} task${freshTasks.length !== 1 ? "s" : ""}${skipNote}:\n` +
        freshTasks.map((t, i) => `${i + 1}. [${t.priority.toUpperCase()}] ${t.title}`).join("\n")
      );
    },
  });

  /* ── Proactive tool: create tasks ────────────────────────────────── */

  const createTasksTool = tool({
    description:
      "Persist one or more structured tasks to the client's task board after you have completed your analysis. " +
      "Call this AFTER writing your analysis response text, not before. " +
      "Use for competitor research, brand audits, content dispatch plans, or any other actionable output. " +
      "Set owner='karos_managed' for tasks Karos AI or staff will execute; 'client_managed' for tasks the client must do themselves.",
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
          }),
        )
        .min(1)
        .max(10),
    }),
    execute: async ({ tasks }) => {
      // Dedup against ALL existing tasks (every status: pending, in_progress,
      // review_pending, completed) so we never recreate work that is already
      // tracked or was recently finished.
      const existingTasks = await listClientTasks({ clientId, limit: 500 });
      const existingNorm = new Set(existingTasks.map((t) => normalizeTitleForDedup(t.title)));
      const freshTasks = tasks.filter(
        (t) => !existingNorm.has(normalizeTitleForDedup(t.title)),
      );
      const skipped = tasks.length - freshTasks.length;

      if (freshTasks.length === 0) {
        return `All ${tasks.length} proposed task${tasks.length !== 1 ? "s" : ""} already exist in the task board — skipped to prevent duplicates.`;
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
            source: t.source as TaskSource,
            owner: t.owner as TaskOwner,
            createdBy: user.uid,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );

      const count = freshTasks.length;
      const skipNote = skipped > 0 ? ` (${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped)` : "";
      return `Created ${count} task${count !== 1 ? "s" : ""} in your task board${skipNote}.`;
    },
  });

  /* ── onFinish: log copilot token usage ───────────────────────────── */

  function logCopilotUsage(usage: { inputTokens?: number; outputTokens?: number }) {
    after(() =>
      logger.logUsage({
        clientId,
        agentId: requestedAgentId,
        agentName: focusedAgent?.name ?? "chat_copilot",
        modelName: MODELS.SONNET,
        operation: "chat_copilot",
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      }),
    );
  }

  /* ── Stream — branch on agent mode ─────────────────────────────── */

  if (focusedAgent) {
    const agent = focusedAgent;

    const runAgentTool = tool({
      description:
        "Trigger a new content generation run for this agent. Use when the user says /run, 'start new generation', 'create new posts', 'generate', or similar intent. " +
        "Collect required field values from the conversation first. Apply defaults for optional fields. Confirm the run with the user before calling.",
      inputSchema: z.object({
        fieldValues: z
          .record(z.string(), z.string())
          .describe(
            "Key-value pairs matching the agent's input field keys. " +
              "Use each field's default value when the user hasn't provided one. " +
              "Do not ask for optional fields the user hasn't mentioned.",
          ),
      }),
      execute: async ({ fieldValues }) => {
        const input: Record<string, string> = {};
        for (const f of agent.fields ?? []) {
          input[f.key] = fieldValues[f.key] ?? f.defaultValue ?? "";
        }
        for (const [k, v] of Object.entries(fieldValues)) {
          if (!(k in input)) input[k] = v;
        }
        try {
          const result = await startAgentRun({ agentId: agent.id, clientId, input, actor: user });
          return (
            `Run started successfully. Job ID: ${result.jobId}. ` +
            `The agent is generating content in the background — drafts will appear in the Agents Hub once complete.`
          );
        } catch (e) {
          return `Failed to start run: ${e instanceof Error ? e.message : "Unknown error"}`;
        }
      },
    });

    const editDraftTool = tool({
      description:
        "Update the content or status of a specific draft asset. Use when the user asks to fix, rewrite, edit, approve, or reject a draft. " +
        "Reference the asset ID from the ACTIVE DRAFTS section. Always confirm the exact change with the user before calling.",
      inputSchema: z.object({
        assetId: z
          .string()
          .describe("The exact asset ID from the ACTIVE DRAFTS list in the system prompt"),
        content: z.string().optional().describe("New content to replace the existing content"),
        status: z
          .enum(["draft", "approved", "delivered", "published"])
          .optional()
          .describe("New status to assign (e.g. 'approved' to approve the draft)"),
      }),
      execute: async ({ assetId, content, status }) => {
        const target = agentAssets.find((a) => a.id === assetId);
        if (!target) return "Asset not found or doesn't belong to this agent's pipeline.";
        const patch: Partial<Asset> = { updatedAt: Date.now() };
        if (content !== undefined) patch.content = content;
        if (status !== undefined) patch.status = status;
        await updateAsset(assetId, patch);
        const label = status ? `status → ${status}` : "content updated";
        return `Draft updated (${label}). The change will appear in the Agents Hub after the page refreshes.`;
      },
    });

    const result = streamText({
      model: MODEL,
      system: systemPrompt,
      messages,
      stopWhen: STOP_WHEN,
      tools: {
        update_branding_guidelines: updateBrandingTool,
        send_support_email: sendSupportEmailTool,
        fetch_gmail_context: fetchGmailContextTool,
        create_tasks: createTasksTool,
        run_agent: runAgentTool,
        edit_draft: editDraftTool,
      },
      onFinish: ({ usage }) => logCopilotUsage(usage),
    });

    return result.toTextStreamResponse();
  }

  // General mode
  const result = streamText({
    model: MODEL,
    system: systemPrompt,
    messages,
    stopWhen: STOP_WHEN,
    tools: {
      update_branding_guidelines: updateBrandingTool,
      send_support_email: sendSupportEmailTool,
      fetch_gmail_context: fetchGmailContextTool,
      create_tasks: createTasksTool,
    },
    onFinish: ({ usage }) => logCopilotUsage(usage),
  });

  return result.toTextStreamResponse();
}
