import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

import { userFromToken } from "@/lib/tokens";
import {
  listClients,
  listAgents,
  getAgent,
  getClient,
  listContextItems,
} from "@/lib/data";
import {
  type DraftFields,
  createDraftAgent,
  saveAgentDraft,
  publishAgent,
  buildTestAgent,
} from "@/lib/agents/authoring";
import { testRunAgent } from "@/lib/agents/run";
import type { AppUser } from "@/lib/types";

/**
 * Remote MCP server (Streamable HTTP) that lets an employee drive agent
 * authoring from their own Claude Code. Auth is a personal access token
 * (Bearer); every tool acts as the resolved user with the same authorization
 * the web app enforces. Mirrors the in-app builder: create draft → test
 * (sandboxed) → publish.
 */

const OUTPUT_KINDS = ["instagram_posts", "email", "article", "social_posts", "freeform"] as const;
const CAPABILITIES = [
  "generate",
  "generate_images",
  "email_client",
  "create_assets",
  "use_transcripts",
  "use_brand_voice",
] as const;

const fieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "textarea", "number", "select"]),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  defaultValue: z.string().optional(),
});

// Shape used for create/update/test. All optional so updates can be partial.
const draftShape = {
  name: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  model: z.string().optional(),
  outputKind: z.enum(OUTPUT_KINDS).optional(),
  systemPrompt: z.string().optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  fields: z.array(fieldSchema).optional(),
  shared: z.boolean().optional(),
};

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

/** Resolve the authed user stashed by withMcpAuth onto the request's authInfo. */
function actor(extra: { authInfo?: { extra?: Record<string, unknown> } }): AppUser {
  const user = extra.authInfo?.extra?.user as AppUser | undefined;
  if (!user) throw new Error("Unauthorized");
  return user;
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_clients",
      {
        description: "List the clients you can build agents for, with their brand voice and contact info.",
        inputSchema: {},
      },
      async (_args, extra) => {
        const user = actor(extra);
        const clients = await listClients(user.role === "KAROS_EMPLOYEE" ? { employeeId: user.uid } : undefined);
        return text(
          clients.map((c) => ({
            id: c.id,
            name: c.name,
            industry: c.industry || null,
            website: c.website || null,
            brandVoice: c.brandVoice || null,
            description: c.description || null,
          })),
        );
      },
    );

    server.registerTool(
      "list_agents",
      {
        description: "List existing agents. Pass status to filter ('draft' or 'published').",
        inputSchema: { status: z.enum(["draft", "published"]).optional() },
      },
      async ({ status }, extra) => {
        actor(extra);
        const agents = await listAgents(status ? { status } : undefined);
        return text(
          agents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status ?? "published",
            outputKind: a.outputKind,
            description: a.description,
          })),
        );
      },
    );

    server.registerTool(
      "get_agent",
      {
        description: "Get the full configuration of a single agent by id.",
        inputSchema: { id: z.string() },
      },
      async ({ id }, extra) => {
        actor(extra);
        const agent = await getAgent(id);
        if (!agent) return err("Agent not found");
        return text(agent);
      },
    );

    server.registerTool(
      "list_client_context",
      {
        description:
          "List the files & images attached to a client's context library. Agents automatically " +
          "use these when running for the client (images as visual reference, PDFs/text read natively).",
        inputSchema: { clientId: z.string() },
      },
      async ({ clientId }, extra) => {
        actor(extra);
        const items = await listContextItems({ clientId });
        return text(
          items.map((i) => ({ id: i.id, kind: i.kind, name: i.name, sizeBytes: i.sizeBytes, note: i.note ?? null })),
        );
      },
    );

    server.registerTool(
      "create_agent",
      {
        description:
          "Create a new in-development DRAFT agent. Provide as much as you know; everything is editable later. " +
          "Drafts are not runnable for clients until published. Returns the new agent id.",
        inputSchema: draftShape,
      },
      async (args, extra) => {
        const user = actor(extra);
        const id = await createDraftAgent(user.uid, args as Partial<DraftFields>);
        return text({ id, status: "draft", message: "Draft created. Test it with test_run_agent, then publish_agent." });
      },
    );

    server.registerTool(
      "update_agent",
      {
        description: "Update a draft agent's fields (partial). Use to iterate on the system prompt, inputs, or capabilities.",
        inputSchema: { id: z.string(), ...draftShape },
      },
      async ({ id, ...patch }, extra) => {
        actor(extra);
        const agent = await getAgent(id);
        if (!agent) return err("Agent not found");
        await saveAgentDraft(id, patch as Partial<DraftFields>);
        return text({ id, message: "Updated." });
      },
    );

    server.registerTool(
      "test_run_agent",
      {
        description:
          "Sandboxed test run against a real client: generates real content (and optionally images) but " +
          "NEVER emails the client, saves assets, or creates a job. Use the returned output to refine the agent. " +
          "Pass either an existing agent `id` OR an inline `config` to test unsaved changes.",
        inputSchema: {
          clientId: z.string(),
          id: z.string().optional(),
          config: z.object(draftShape).optional(),
          values: z.record(z.string(), z.string()).optional(),
          withImages: z.boolean().optional(),
        },
      },
      async ({ clientId, id, config, values, withImages }, extra) => {
        const user = actor(extra);
        const client = await getClient(clientId);
        if (!client) return err("Client not found");

        let agent;
        if (id) {
          const existing = await getAgent(id);
          if (!existing) return err("Agent not found");
          agent = existing;
        } else if (config) {
          agent = buildTestAgent(user.uid, {
            name: "Test agent",
            description: "",
            icon: "Sparkles",
            color: "#2dff9e",
            model: "claude-sonnet-4-6",
            outputKind: "freeform",
            systemPrompt: "",
            capabilities: ["generate"],
            fields: [],
            shared: true,
            ...(config as Partial<DraftFields>),
          });
        } else {
          return err("Provide either an agent `id` or an inline `config`.");
        }

        const result = await testRunAgent({
          agent,
          client,
          input: values ?? {},
          withImages: withImages ?? false,
        });
        return text(result);
      },
    );

    server.registerTool(
      "publish_agent",
      {
        description: "Publish a draft agent so it becomes live and runnable for clients. Requires a name and system prompt.",
        inputSchema: { id: z.string() },
      },
      async ({ id }, extra) => {
        actor(extra);
        const agent = await getAgent(id);
        if (!agent) return err("Agent not found");
        try {
          await publishAgent(id, {
            name: agent.name,
            description: agent.description,
            icon: agent.icon,
            color: agent.color,
            model: agent.model,
            outputKind: agent.outputKind,
            systemPrompt: agent.systemPrompt,
            capabilities: agent.capabilities,
            fields: agent.fields,
            shared: agent.shared,
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : "Publish failed");
        }
        return text({ id, status: "published", message: "Published — now runnable for clients." });
      },
    );
  },
  {},
  { basePath: "/api", maxDuration: 300 },
);

const authedHandler = withMcpAuth(
  handler,
  async (_req, bearer) => {
    const user = await userFromToken(bearer);
    if (!user) return undefined;
    return {
      token: bearer as string,
      clientId: user.uid,
      scopes: [],
      extra: { user },
    };
  },
  { required: true },
);

export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
