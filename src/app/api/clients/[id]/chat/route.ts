import { streamText, tool, isLoopFinished, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { ModelMessage } from "ai";

import { getCurrentUser } from "@/lib/auth";
import {
  getClient,
  getClientReport,
  listClientCompetitors,
  listAgents,
  listJobs,
  listAssets,
  updateClient,
} from "@/lib/data";
import { buildCopilotSystemPrompt } from "@/lib/copilot-context";
import { sendEmail } from "@/lib/email";
import type { BrandingGuidelines } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: clientId } = await params;

  // Client-role users may only access their own chat
  if (user.role === "client" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { messages?: Array<{ role: "user" | "assistant"; content: string }> };
  const messages = (body.messages ?? []) as ModelMessage[];

  // Fetch all context data in parallel
  const [client, report, competitors, agents, jobs, assets] = await Promise.all([
    getClient(clientId),
    getClientReport(clientId),
    listClientCompetitors(clientId),
    listAgents({ status: "published" }),
    listJobs({ clientId }),
    listAssets({ clientId }),
  ]);

  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  const systemPrompt = buildCopilotSystemPrompt(client, report, competitors, agents, jobs, assets);

  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    system: systemPrompt,
    messages,
    // Allow one tool call cycle: Claude → tool → Claude responds
    stopWhen: [isLoopFinished(), stepCountIs(3)],
    tools: {
      update_branding_guidelines: tool({
        description:
          "Update this client's branding guidelines. Call this when the user asks to change brand colors, fonts, or tone keywords. Only call after the user has confirmed the specific change.",
        inputSchema: z.object({
          primaryColor: z
            .string()
            .optional()
            .describe("Primary brand color as a hex code e.g. #1E3A5F"),
          secondaryColor: z
            .string()
            .optional()
            .describe("Secondary / accent color as a hex code"),
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
          const updated: BrandingGuidelines = {
            ...current,
            updatedAt: Date.now(),
          };
          if (args.primaryColor !== undefined) updated.primaryColor = args.primaryColor;
          if (args.secondaryColor !== undefined) updated.secondaryColor = args.secondaryColor;
          if (args.fontHeading !== undefined) updated.fontHeading = args.fontHeading;
          if (args.fontBody !== undefined) updated.fontBody = args.fontBody;
          if (args.toneKeywords !== undefined) updated.toneKeywords = args.toneKeywords;
          if (args.guidelines !== undefined) updated.guidelines = args.guidelines;
          await updateClient(clientId, { brandingGuidelines: updated });
          return "Branding guidelines updated successfully.";
        },
      }),

      send_support_email: tool({
        description:
          "Send a support request email to the Karos Labs admin team on behalf of the client. Use when the user reports a problem, requests human help, or asks you to escalate an issue you cannot resolve.",
        inputSchema: z.object({
          subject: z.string().describe("Concise email subject line"),
          message: z
            .string()
            .describe("Full message body summarising the issue or request clearly"),
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
      }),
    },
  });

  return result.toTextStreamResponse();
}
