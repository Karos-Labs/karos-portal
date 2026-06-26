import { streamText, tool, isLoopFinished, stepCountIs } from "ai";
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
  updateClient,
  updateAsset,
  upsertClientContextDoc,
  getClientContextDoc,
} from "@/lib/data";
import { buildCopilotSystemPrompt, buildAgentCopilotSystemPrompt } from "@/lib/copilot-context";
import { startAgentRun } from "@/lib/agents/run";
import { sendEmail } from "@/lib/email";
import { brandingToContextDocContent } from "@/lib/branding";
import type { Agent, Asset, BrandingGuidelines } from "@/lib/types";

export const maxDuration = 60;

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

  // Fetch all context data in parallel
  const [client, report, competitors, contextDocs, allAgents, jobs, assets] = await Promise.all([
    getClient(clientId),
    getClientReport(clientId),
    listClientCompetitors(clientId),
    listClientContextDocs(clientId),
    listAgents({ status: "published" }),
    listJobs({ clientId }),
    listAssets({ clientId }),
  ]);

  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  // Resolve agent-specific mode — exclude system agents for safety
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

  const systemPrompt = focusedAgent
    ? buildAgentCopilotSystemPrompt(focusedAgent, client, agentJobs, agentAssets, contextDocs)
    : buildCopilotSystemPrompt(client, report, competitors, allAgents, jobs, assets, contextDocs);

  /* ── Shared tools (always available) ────────────────────────────────── */

  const updateBrandingTool = tool({
    description:
      "Update this client's branding guidelines. Call this when the user asks to change brand colors, fonts, or tone keywords. Only call after the user has confirmed the specific change.",
    inputSchema: z.object({
      primaryColor: z.string().optional().describe("Primary brand color as a hex code e.g. #1E3A5F"),
      secondaryColor: z.string().optional().describe("Secondary / accent color as a hex code"),
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
      if (args.primaryColor !== undefined) updated.primaryColor = args.primaryColor;
      if (args.secondaryColor !== undefined) updated.secondaryColor = args.secondaryColor;
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

  /* ── Stream — branch on mode so each tools object is fully typed ─────── */

  const MODEL = anthropic("claude-sonnet-4-6");
  const STOP_WHEN = [isLoopFinished(), stepCountIs(3)];

  if (focusedAgent) {
    // Capture non-null reference so closures below are narrowed
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
        // Merge provided values with defaults from the agent's field definitions
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
        // Validate asset belongs to this agent — prevents cross-agent edits
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
        run_agent: runAgentTool,
        edit_draft: editDraftTool,
      },
    });

    return result.toTextStreamResponse();
  }

  // General mode — no agent tools
  const result = streamText({
    model: MODEL,
    system: systemPrompt,
    messages,
    stopWhen: STOP_WHEN,
    tools: {
      update_branding_guidelines: updateBrandingTool,
      send_support_email: sendSupportEmailTool,
    },
  });

  return result.toTextStreamResponse();
}
