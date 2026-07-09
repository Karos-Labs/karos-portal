import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  createAsset,
  createContextItem,
  getAsset,
  getClient,
  getJob,
  listAssets,
  listClientContextDocs,
  listClients,
  listContextItems,
  listJobs,
} from "@/lib/data";
import { uploadBytes } from "@/lib/storage";
import { contextKind } from "@/lib/context";
import { MANAGED_PRODUCTS } from "@/lib/agent-service/products";
import { submitManagedJob } from "@/lib/jobs/submit-managed";
import type { AssetType, Client, ManagedTaskType } from "@/lib/types";
import { canStaffAccessClient, type McpActor } from "./auth";
import { type McpTool, textResult, ToolError } from "./protocol";

/**
 * The Karos MCP toolset. Every client-scoped tool authorizes the actor against
 * the target client: staff by their client assignments, a service (job) actor
 * against the single client its token was minted for. Service callers may omit
 * `clientId` — it defaults to their own — so a runner can just call
 * `get_client` / `list_client_context` with no arguments.
 */

const ASSET_TYPES = ["instagram_post", "email", "article", "social_post", "note"] as const;
const CONTEXT_DOC_CONTENT_CAP = 24_000;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MB decoded

/** Resolve the effective clientId — falling back to a service actor's own client. */
function resolveClientId(actor: McpActor, provided?: string): string {
  const clientId = provided ?? (actor.kind === "service" ? actor.clientId : undefined);
  if (!clientId) throw new ToolError("clientId is required");
  return clientId;
}

/** Load a client and assert the actor may act on it, or throw a ToolError. */
async function requireClient(actor: McpActor, clientId: string): Promise<Client> {
  if (actor.kind === "service" && actor.clientId !== clientId) {
    throw new ToolError("This job token is scoped to a different client.");
  }
  const client = await getClient(clientId);
  if (!client) throw new ToolError("Client not found.");
  if (actor.kind === "staff" && !canStaffAccessClient(actor.user, client)) {
    throw new ToolError("You don't have access to this client.");
  }
  return client;
}

/** uid to stamp on writes: the acting staff user, or an agent-service sentinel. */
function actorUid(actor: McpActor): string {
  return actor.kind === "staff" ? actor.user.uid : "agent-service";
}

function decodeBase64(input: string, label: string): Buffer {
  // Tolerate a data: URL prefix — models often produce them.
  const comma = input.startsWith("data:") ? input.indexOf(",") : -1;
  const raw = comma >= 0 ? input.slice(comma + 1) : input;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64");
  } catch {
    throw new ToolError(`${label} is not valid base64.`);
  }
  if (bytes.length === 0) throw new ToolError(`${label} is empty.`);
  if (bytes.length > UPLOAD_MAX_BYTES) {
    throw new ToolError(`${label} is larger than ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`);
  }
  return bytes;
}

const clientIdArg = z.string().min(1).optional();

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_clients",
    description:
      "List the clients you can access (id, name, industry, website, brand voice, status). Staff only.",
    actors: ["staff"],
    schema: z.object({}),
    handler: async (_args, actor) => {
      if (actor.kind !== "staff") throw new ToolError("Staff only.");
      const clients = await listClients(
        actor.user.role === "KAROS_EMPLOYEE" ? { employeeId: actor.user.uid } : undefined,
      );
      return textResult(
        clients.map((c) => ({
          id: c.id,
          name: c.name,
          industry: c.industry ?? null,
          website: c.website ?? null,
          brandVoice: c.brandVoice ?? null,
          status: c.status,
          agentsRepoSlug: c.agentsRepoSlug ?? null,
        })),
      );
    },
  },

  {
    name: "get_client",
    description:
      "Full profile for one client — brand voice, description, industry, social links, branding. " +
      "Service (job) callers may omit clientId to get their own client.",
    actors: ["staff", "service"],
    schema: z.object({ clientId: clientIdArg }),
    handler: async (args, actor) => {
      const { clientId } = args as { clientId?: string };
      const c = await requireClient(actor, resolveClientId(actor, clientId));
      return textResult({
        id: c.id,
        name: c.name,
        website: c.website ?? null,
        industry: c.industry ?? null,
        category: c.category ?? null,
        description: c.description ?? null,
        brief: c.brief ?? null,
        brandVoice: c.brandVoice ?? null,
        socialLinks: c.socialLinks ?? null,
        brandingGuidelines: c.brandingGuidelines ?? null,
        accentColor: c.accentColor ?? null,
        logoUrl: c.logoUrl ?? null,
        agentsRepoSlug: c.agentsRepoSlug ?? null,
        status: c.status,
      });
    },
  },

  {
    name: "list_client_context",
    description:
      "List files & images attached to a client (id, name, kind, mime type, note, purpose, url). " +
      "These are the reference materials agents use when running for the client.",
    actors: ["staff", "service"],
    schema: z.object({ clientId: clientIdArg }),
    handler: async (args, actor) => {
      const { clientId } = args as { clientId?: string };
      const id = resolveClientId(actor, clientId);
      await requireClient(actor, id);
      const items = await listContextItems({ clientId: id });
      return textResult(
        items.map((i) => ({
          id: i.id,
          name: i.name,
          kind: i.kind,
          mimeType: i.mimeType,
          sizeBytes: i.sizeBytes,
          note: i.note ?? null,
          purpose: i.purpose ?? null,
          url: i.url,
        })),
      );
    },
  },

  {
    name: "get_client_context_docs",
    description:
      "The client's living context documents (brand-voice, market-strategy, target-audience, product-information, etc.) — " +
      "analyst-grade markdown from onboarding. Optionally filter by docType. Long content is truncated.",
    actors: ["staff", "service"],
    schema: z.object({
      clientId: clientIdArg,
      docType: z.string().optional(),
    }),
    handler: async (args, actor) => {
      const { clientId, docType } = args as { clientId?: string; docType?: string };
      const id = resolveClientId(actor, clientId);
      await requireClient(actor, id);
      const docs = await listClientContextDocs(id, "internal");
      const filtered = docType ? docs.filter((d) => d.docType === docType) : docs;
      return textResult(
        filtered.map((d) => {
          const truncated = d.content.length > CONTEXT_DOC_CONTENT_CAP;
          return {
            docType: d.docType,
            version: d.version,
            summary: d.summary ?? null,
            sources: d.sources ?? null,
            truncated,
            content: truncated ? d.content.slice(0, CONTEXT_DOC_CONTENT_CAP) : d.content,
          };
        }),
      );
    },
  },

  {
    name: "list_assets",
    description:
      "List a client's assets (generated content) — id, type, title, status, imageUrl, timestamps. " +
      "Optionally filter by status.",
    actors: ["staff", "service"],
    schema: z.object({
      clientId: clientIdArg,
      status: z.enum(["draft", "approved", "delivered", "published", "scheduled"]).optional(),
    }),
    handler: async (args, actor) => {
      const { clientId, status } = args as { clientId?: string; status?: string };
      const id = resolveClientId(actor, clientId);
      await requireClient(actor, id);
      const assets = await listAssets({ clientId: id });
      const filtered = status ? assets.filter((a) => a.status === status) : assets;
      return textResult(
        filtered.map((a) => ({
          id: a.id,
          type: a.type,
          title: a.title,
          status: a.status,
          imageUrl: a.imageUrl ?? null,
          jobId: a.jobId ?? null,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        })),
      );
    },
  },

  {
    name: "get_asset",
    description: "Full asset by id — including body content and structured meta (hashtags, subject line, etc.).",
    actors: ["staff", "service"],
    schema: z.object({ id: z.string().min(1) }),
    handler: async (args, actor) => {
      const { id } = args as { id: string };
      const asset = await getAsset(id);
      if (!asset) throw new ToolError("Asset not found.");
      await requireClient(actor, asset.clientId);
      return textResult(asset);
    },
  },

  {
    name: "list_jobs",
    description: "List a client's jobs (agent runs) — id, title, status, agentName, timestamps. Optionally filter by status.",
    actors: ["staff", "service"],
    schema: z.object({
      clientId: clientIdArg,
      status: z.enum(["queued", "running", "review", "approved", "delivered", "failed"]).optional(),
    }),
    handler: async (args, actor) => {
      const { clientId, status } = args as { clientId?: string; status?: string };
      const id = resolveClientId(actor, clientId);
      await requireClient(actor, id);
      const jobs = await listJobs({ clientId: id });
      const filtered = status ? jobs.filter((j) => j.status === status) : jobs;
      return textResult(
        filtered.map((j) => ({
          id: j.id,
          title: j.title,
          status: j.status,
          agentName: j.agentName,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
        })),
      );
    },
  },

  {
    name: "get_job",
    description: "Full job by id — status, input, run events, error, and produced asset ids.",
    actors: ["staff", "service"],
    schema: z.object({ id: z.string().min(1) }),
    handler: async (args, actor) => {
      const { id } = args as { id: string };
      const job = await getJob(id);
      if (!job) throw new ToolError("Job not found.");
      await requireClient(actor, job.clientId);
      return textResult({
        id: job.id,
        clientId: job.clientId,
        title: job.title,
        status: job.status,
        agentName: job.agentName,
        input: job.input,
        events: job.events,
        error: job.error ?? null,
        assetIds: job.assetIds,
        external: job.external ?? null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    },
  },

  {
    name: "list_products",
    description:
      "The managed products you can submit as jobs (social_post, newsletter_issue, blog_article, landing_page), " +
      "with each product's brief fields and which are required.",
    actors: ["staff", "service"],
    schema: z.object({}),
    handler: async () =>
      textResult(
        MANAGED_PRODUCTS.map((p) => ({
          taskType: p.taskType,
          name: p.name,
          description: p.description,
          estimate: p.estimate,
          deliverables: p.deliverables,
          briefFields: p.briefFields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required ?? false,
            helper: f.helper ?? null,
            options: f.options?.map((o) => o.value) ?? null,
          })),
        })),
      ),
  },

  {
    name: "submit_job",
    description:
      "Submit a managed job to the agent service for a client. taskType is one of the products from list_products; " +
      "brief is that product's fields. Returns the new job id (poll with get_job). Staff only.",
    actors: ["staff"],
    schema: z.object({
      clientId: z.string().min(1),
      taskType: z.enum(["social_post", "newsletter_issue", "blog_article", "landing_page"]),
      brief: z.record(z.string(), z.unknown()),
      contextItemIds: z.array(z.string()).optional(),
    }),
    handler: async (args, actor) => {
      if (actor.kind !== "staff") throw new ToolError("Staff only.");
      const { clientId, taskType, brief, contextItemIds } = args as {
        clientId: string;
        taskType: ManagedTaskType;
        brief: Record<string, unknown>;
        contextItemIds?: string[];
      };
      await requireClient(actor, clientId);
      const result = await submitManagedJob(actor.user, { clientId, taskType, brief, contextItemIds });
      if (result.error) throw new ToolError(result.error);
      return textResult({ jobId: result.jobId, status: "queued" });
    },
  },

  {
    name: "upload_context_file",
    description:
      "Attach a reference file/image to a client (base64-encoded). Becomes context agents use for the client. " +
      "Service (job) callers may omit clientId to attach to their own client. Max 10 MB.",
    actors: ["staff", "service"],
    schema: z.object({
      clientId: clientIdArg,
      filename: z.string().min(1),
      mimeType: z.string().min(1),
      contentBase64: z.string().min(1),
      note: z.string().optional(),
      purpose: z.enum(["newsletter_reference", "image_pool"]).optional(),
    }),
    handler: async (args, actor) => {
      const { clientId, filename, mimeType, contentBase64, note, purpose } = args as {
        clientId?: string;
        filename: string;
        mimeType: string;
        contentBase64: string;
        note?: string;
        purpose?: "newsletter_reference" | "image_pool";
      };
      const id = resolveClientId(actor, clientId);
      await requireClient(actor, id);
      const bytes = decodeBase64(contentBase64, "contentBase64");
      const safeName = filename.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "file";
      const path = `clients/${id}/context/${randomUUID()}-${safeName}`;
      const { url, path: storagePath } = await uploadBytes({ bytes, path, contentType: mimeType });
      const itemId = await createContextItem({
        clientId: id,
        kind: contextKind(mimeType),
        name: filename,
        mimeType,
        sizeBytes: bytes.length,
        storagePath,
        url,
        ...(note ? { note } : {}),
        ...(purpose ? { purpose } : {}),
        createdBy: actorUid(actor),
        createdAt: Date.now(),
      });
      return textResult({ id: itemId, name: filename, url });
    },
  },

  {
    name: "upload_asset",
    description:
      "Create an asset (generated content) for a client — title + body content, optional structured meta, and an " +
      "optional base64 image. Saved as a draft for review. Service (job) callers may omit clientId; the asset is " +
      "linked to their job. Max 10 MB image.",
    actors: ["staff", "service"],
    schema: z.object({
      clientId: clientIdArg,
      type: z.enum(ASSET_TYPES),
      title: z.string().min(1),
      content: z.string(),
      meta: z.record(z.string(), z.unknown()).optional(),
      imageBase64: z.string().optional(),
      imageMimeType: z.string().optional(),
      imageUrl: z.string().url().optional(),
    }),
    handler: async (args, actor) => {
      const { clientId, type, title, content, meta, imageBase64, imageMimeType, imageUrl } = args as {
        clientId?: string;
        type: AssetType;
        title: string;
        content: string;
        meta?: Record<string, unknown>;
        imageBase64?: string;
        imageMimeType?: string;
        imageUrl?: string;
      };
      const id = resolveClientId(actor, clientId);
      await requireClient(actor, id);

      let finalImageUrl: string | null = imageUrl ?? null;
      if (imageBase64) {
        const mime = imageMimeType ?? "image/png";
        const bytes = decodeBase64(imageBase64, "imageBase64");
        const ext = mime.split("/")[1]?.replace(/[^\w]+/g, "") || "png";
        const path = `clients/${id}/assets/${randomUUID()}.${ext}`;
        const uploaded = await uploadBytes({ bytes, path, contentType: mime });
        finalImageUrl = uploaded.url;
      }

      const now = Date.now();
      const assetId = await createAsset({
        clientId: id,
        jobId: actor.kind === "service" ? actor.jobId : null,
        agentId: actor.kind === "service" ? "agent-service" : null,
        type,
        title,
        content,
        ...(meta ? { meta } : {}),
        imageUrl: finalImageUrl,
        status: "draft",
        createdBy: actorUid(actor),
        createdAt: now,
        updatedAt: now,
      });
      return textResult({ id: assetId, status: "draft", imageUrl: finalImageUrl });
    },
  },
];
