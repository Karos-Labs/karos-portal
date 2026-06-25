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
  upsertClientContextDoc,
  getClientContextDoc,
} from "@/lib/data";
import { buildCopilotSystemPrompt } from "@/lib/copilot-context";
import { sendEmail } from "@/lib/email";
import type { BrandingGuidelines } from "@/lib/types";

function brandingToContextDocContent(g: BrandingGuidelines, clientName: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`# Branding Guidelines — ${clientName}`, `_Last updated: ${today}_`, ""];
  if (g.primaryColor || g.secondaryColor) {
    lines.push("## Color Palette");
    if (g.primaryColor) lines.push(`- **Primary:** ${g.primaryColor}`);
    if (g.secondaryColor) lines.push(`- **Secondary/Accent:** ${g.secondaryColor}`);
    lines.push("");
  }
  if (g.fontHeading || g.fontBody) {
    lines.push("## Typography");
    if (g.fontHeading) lines.push(`- **Heading font:** ${g.fontHeading}`);
    if (g.fontBody) lines.push(`- **Body font:** ${g.fontBody}`);
    lines.push("");
  }
  if (g.toneKeywords?.length) {
    lines.push("## Tone & Voice", `Keywords: ${g.toneKeywords.join(", ")}`, "");
  }
  if (g.guidelines) {
    lines.push("## Brand Guidelines", g.guidelines, "");
  }
  return lines.join("\n");
}

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
  const [client, report, competitors, contextDocs, agents, jobs, assets] = await Promise.all([
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

  const systemPrompt = buildCopilotSystemPrompt(client, report, competitors, agents, jobs, assets, contextDocs);

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
          // Sync branding-guidelines context doc so AI context stays consistent
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
            // Non-fatal: branding update already succeeded
          }
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
