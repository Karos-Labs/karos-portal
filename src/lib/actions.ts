"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { adminAuth } from "@/lib/firebase/admin";
import {
  createClient,
  updateClient,
  getClient,
  createAgent,
  updateAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAsset,
  getAsset,
  updateTranscript,
  getTranscript,
  upsertUser,
  getUser,
  deleteUser,
  listAccessTokens,
  updateAccessToken,
  getContextItem,
  updateContextItem,
  deleteContextItem,
} from "@/lib/data";
import { issueAccessToken } from "@/lib/tokens";
import { deleteObject } from "@/lib/storage";
import { startAgentRun, testRunAgent, type TestRunResult } from "@/lib/agents/run";
import {
  type DraftFields,
  createDraftAgent,
  saveAgentDraft,
  publishAgent,
  unpublishAgent,
  buildTestAgent,
} from "@/lib/agents/authoring";
import { ingestTranscript } from "@/lib/transcripts/ingest";
import type { Agent, AppUser, Client, Role } from "@/lib/types";

async function requireStaff(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  if (user.role !== "admin" && user.role !== "employee") throw new Error("Forbidden");
  return user;
}

async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") throw new Error("Forbidden");
  return user;
}

/* ------------------------------ clients ------------------------------ */

export async function createClientAction(input: {
  name: string;
  website?: string;
  industry?: string;
  contactEmail?: string;
  domains?: string;
  description?: string;
  brandVoice?: string;
  assignedEmployeeIds?: string[];
}) {
  const user = await requireStaff();
  const id = await createClient({
    name: input.name.trim(),
    website: input.website?.trim() || "",
    industry: input.industry?.trim() || "",
    contactEmail: input.contactEmail?.trim().toLowerCase() || "",
    domains: (input.domains ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    description: input.description?.trim() || "",
    brandVoice: input.brandVoice?.trim() || "",
    assignedEmployeeIds: input.assignedEmployeeIds ?? [user.uid],
    status: "active",
    createdAt: Date.now(),
    createdBy: user.uid,
  });
  revalidatePath("/clients");
  return { id };
}

export async function updateClientAction(id: string, input: Partial<Client> & { domainsCsv?: string }) {
  await requireStaff();
  const patch: Partial<Client> = { ...input };
  if (input.domainsCsv !== undefined) {
    patch.domains = input.domainsCsv.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    delete (patch as { domainsCsv?: string }).domainsCsv;
  }
  if (patch.contactEmail) patch.contactEmail = patch.contactEmail.toLowerCase();
  await updateClient(id, patch);
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
}

/* ------------------------------- agents ------------------------------ */

/** Create an in-development draft. Used for lazy creation on the builder's first edit. */
export async function createDraftAgentAction(initial: Partial<DraftFields>) {
  const user = await requireStaff();
  const id = await createDraftAgent(user.uid, initial);
  revalidatePath("/agents");
  return { id };
}

/** Autosave a draft's working state. Intentionally does not revalidate (avoids typing churn). */
export async function saveAgentDraftAction(id: string, patch: Partial<DraftFields>) {
  await requireStaff();
  await saveAgentDraft(id, patch);
}

/** Publish a draft into a live, runnable agent (validates required fields). */
export async function publishAgentAction(id: string, fields: DraftFields) {
  await requireStaff();
  await publishAgent(id, fields);
  revalidatePath(`/agents/${id}`);
  revalidatePath("/agents");
  return { id };
}

/** Send a live agent back to in-development. */
export async function unpublishAgentAction(id: string) {
  await requireStaff();
  await unpublishAgent(id);
  revalidatePath(`/agents/${id}`);
  revalidatePath("/agents");
}

/** Sandboxed test run from the builder's live config — no email, no assets, no job. */
export async function testRunAgentAction(input: {
  config: DraftFields;
  clientId: string;
  values: Record<string, string>;
  withImages: boolean;
}): Promise<TestRunResult> {
  const user = await requireStaff();
  const client = await getClient(input.clientId);
  if (!client) throw new Error("Pick a client to test against.");
  const agent = buildTestAgent(user.uid, input.config);
  return testRunAgent({ agent, client, input: input.values, withImages: input.withImages });
}

export async function deleteAgentAction(id: string) {
  await requireStaff();
  await deleteAgent(id);
  revalidatePath("/agents");
}

export async function toggleAgentAction(id: string) {
  await requireStaff();
  const agent = await getAgent(id);
  if (!agent) throw new Error("Agent not found");
  await updateAgent(id, { isActive: !agent.isActive, updatedAt: Date.now() });
  revalidatePath("/agents");
}

/* -------------------------------- runs ------------------------------- */

export async function runAgentAction(input: {
  agentId: string;
  clientId: string;
  input: Record<string, string>;
}) {
  const user = await requireStaff();
  // Returns as soon as the job row exists; generation continues in the
  // background so the user can keep navigating the app.
  const result = await startAgentRun({
    agentId: input.agentId,
    clientId: input.clientId,
    input: input.input,
    actor: user,
  });
  revalidatePath("/jobs");
  revalidatePath(`/clients/${input.clientId}`);
  revalidatePath("/assets");
  return result;
}

/* ------------------------------- assets ------------------------------ */

export async function updateAssetAction(id: string, patch: { content?: string; title?: string; status?: "draft" | "approved" | "delivered" | "published" }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) throw new Error("Unauthorized");
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset not found");
  // Clients may only act on their own assets.
  if (user.role === "client" && asset.clientId !== user.clientId) throw new Error("Forbidden");
  await updateAsset(id, { ...patch, updatedAt: Date.now() });
  revalidatePath("/assets");
  revalidatePath(`/clients/${asset.clientId}`);
}

/* ----------------------------- transcripts --------------------------- */

export async function assignTranscriptAction(id: string, clientId: string | null) {
  await requireStaff();
  await updateTranscript(id, { clientId, assignment: clientId ? "manual" : "unassigned" });
  const t = await getTranscript(id);
  revalidatePath("/transcripts");
  if (t?.clientId) revalidatePath(`/clients/${t.clientId}`);
}

export async function ingestManualTranscriptAction(input: {
  title: string;
  participants: string;
  rawText: string;
}) {
  await requireStaff();
  const result = await ingestTranscript(
    {
      externalId: `manual-${Date.now()}`,
      title: input.title.trim() || "Pasted meeting",
      participants: input.participants.split(",").map((p) => p.trim()).filter(Boolean),
      text: input.rawText,
      date: Date.now(),
    },
    "manual",
  );
  revalidatePath("/transcripts");
  return result;
}

/* ------------------------- starter agents ---------------------------- */

const STARTER_AGENTS: Omit<Agent, "id" | "createdAt" | "updatedAt" | "createdBy" | "runCount">[] = [
  {
    name: "Instagram + Email Agent",
    description:
      "Generates on-brand Instagram posts (caption, hashtags & visual brief) and emails the drafts straight to the client for review.",
    icon: "Camera",
    color: "#2dff9e",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are a senior social media strategist at a marketing agency. You write scroll-stopping, on-brand Instagram captions that drive engagement. Match the client's brand voice exactly. Each post must have a strong hook in the first line, a clear value or story in the body, a natural call-to-action, a tight set of relevant hashtags (mix of broad and niche, no banned/spammy tags), and a concrete art-direction brief for the accompanying visual. Never use clichés or generic filler.",
    outputKind: "instagram_posts",
    fields: [
      { key: "topic", label: "Topic / campaign", type: "text", placeholder: "Summer launch, product highlight…", required: true },
      { key: "count", label: "How many posts", type: "select", options: ["1", "2", "3", "4", "5"], defaultValue: "3" },
      { key: "goal", label: "Goal (optional)", type: "text", placeholder: "Drive sign-ups, build awareness…" },
      { key: "notes", label: "Extra notes (optional)", type: "textarea", placeholder: "Anything specific to include or avoid" },
    ],
    capabilities: ["generate", "generate_images", "create_assets", "email_client", "use_brand_voice", "use_transcripts"],
    status: "published",
    isActive: true,
    shared: true,
  },
  {
    name: "Writer Agent",
    description: "Drafts long-form articles, blog posts and copy tailored to the client's brand voice.",
    icon: "PenLine",
    color: "#a78bfa",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are an expert long-form content writer for a marketing agency. Write clear, engaging, well-structured articles in the client's brand voice. Use compelling headlines, scannable subheads, and a strong intro and conclusion. Avoid fluff and AI clichés.",
    outputKind: "article",
    fields: [
      { key: "topic", label: "Topic", type: "text", placeholder: "Article subject", required: true },
      { key: "wordCount", label: "Target length", type: "select", options: ["500", "800", "1200", "2000"], defaultValue: "800" },
      { key: "keywords", label: "Keywords (optional)", type: "text", placeholder: "comma separated" },
    ],
    capabilities: ["generate", "create_assets", "use_brand_voice"],
    status: "published",
    isActive: true,
    shared: true,
  },
  {
    name: "Email Campaign Agent",
    description: "Writes a complete marketing email (subject + body) and delivers it to the client to review.",
    icon: "Mail",
    color: "#5db4ff",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are an email marketing specialist. Write a high-converting marketing email in the client's brand voice. Start with the subject line on its own first line prefixed with 'Subject:'. Then write a compelling, concise body with one clear call-to-action.",
    outputKind: "email",
    fields: [
      { key: "topic", label: "Campaign / offer", type: "text", placeholder: "What is this email about?", required: true },
      { key: "audience", label: "Audience (optional)", type: "text", placeholder: "New leads, existing customers…" },
    ],
    capabilities: ["generate", "create_assets", "email_client", "use_brand_voice"],
    status: "published",
    isActive: true,
    shared: true,
  },
  {
    name: "Social Posts Agent",
    description: "Generates a batch of short posts for X/LinkedIn from a single idea, on brand.",
    icon: "Share2",
    color: "#ffcf5d",
    model: "claude-sonnet-4-6",
    systemPrompt:
      "You are a social media copywriter. Produce a numbered batch of short, punchy social posts (suitable for X and LinkedIn) from the brief, in the client's brand voice. Vary the angle of each post.",
    outputKind: "social_posts",
    fields: [
      { key: "topic", label: "Idea / theme", type: "text", placeholder: "What should the posts be about?", required: true },
      { key: "count", label: "How many", type: "select", options: ["3", "5", "8"], defaultValue: "5" },
    ],
    capabilities: ["generate", "create_assets", "use_brand_voice"],
    status: "published",
    isActive: true,
    shared: true,
  },
];

export async function seedAgentsAction() {
  const user = await requireStaff();
  const now = Date.now();
  const ids: string[] = [];
  for (const a of STARTER_AGENTS) {
    ids.push(await createAgent({ ...a, createdBy: user.uid, createdAt: now, updatedAt: now, runCount: 0 }));
  }
  revalidatePath("/agents");
  return { count: ids.length };
}

/**
 * Import the karos-labs skill library (the `karos/*` library + the XO Digital client skills)
 * as runnable agents, mapping each SKILL.md onto an Agent system prompt (see labs-import.ts).
 *
 * Idempotent: keyed by `labsSkillId`, a re-run UPDATES each skill's agent in place (refreshing
 * name/description/prompt/config) rather than creating duplicates, and never overwrites the
 * agent's lifecycle (status/isActive) — so an admin who unpublished one keeps that choice.
 * Admin only: it bulk-creates dozens of live agents.
 */
export async function importLabsSkillsAction() {
  const user = await requireAdmin();
  const { buildLabsAgentSpecs } = await import("@/lib/agents/labs-import");
  const specs = buildLabsAgentSpecs();

  const existing = await listAgents();
  const byLabsId = new Map(
    existing.filter((a) => a.labsSkillId).map((a) => [a.labsSkillId as string, a] as const),
  );

  const now = Date.now();
  const result = { created: 0, updated: 0, failed: 0, total: specs.length };
  const CHUNK = 12; // bound Firestore write concurrency

  for (let i = 0; i < specs.length; i += CHUNK) {
    // allSettled so one transient Firestore error doesn't abort the whole import; a re-click is
    // idempotent, so the admin can retry just the failures.
    const settled = await Promise.allSettled(
      specs.slice(i, i + CHUNK).map(async (s) => {
        const config = {
          name: s.name,
          description: s.description,
          icon: s.icon,
          color: s.color,
          model: s.model,
          systemPrompt: s.systemPrompt,
          outputKind: s.outputKind,
          fields: s.fields,
          capabilities: s.capabilities,
          shared: s.shared,
        };
        const prior = byLabsId.get(s.labsSkillId);
        if (prior) {
          await updateAgent(prior.id, { ...config, updatedAt: now });
          return "updated" as const;
        }
        await createAgent({
          ...config,
          status: "published",
          isActive: true,
          labsSkillId: s.labsSkillId,
          createdBy: user.uid,
          createdAt: now,
          updatedAt: now,
          runCount: 0,
        });
        return "created" as const;
      }),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") result[r.value]++;
      else result.failed++;
    }
  }

  revalidatePath("/agents");
  return result;
}

/* -------------------------------- team ------------------------------- */

export async function createTeamMemberAction(input: {
  name: string;
  email: string;
  password: string;
  role: Role;
  clientId?: string;
  assignedClientIds?: string[];
}) {
  await requireAdmin();
  const email = input.email.trim().toLowerCase();
  const userRecord = await adminAuth().createUser({
    email,
    password: input.password,
    displayName: input.name,
  });
  const user: AppUser = {
    uid: userRecord.uid,
    email,
    name: input.name.trim(),
    role: input.role,
    clientId: input.role === "client" ? input.clientId ?? null : null,
    assignedClientIds: input.role === "employee" ? input.assignedClientIds ?? [] : [],
    disabled: false,
    // Admin-created logins are approved on the spot — they never hit the Registrations queue.
    approvedAt: Date.now(),
    createdAt: Date.now(),
  };
  await upsertUser(user);
  revalidatePath("/team");
  return { uid: userRecord.uid };
}

/* --------------------------- registrations --------------------------- */

/**
 * Approve a pending self-signup: set the final role, link/create a client (for clients) or
 * assign clients (for employees), and flip the account live.
 */
export async function approveRegistrationAction(
  uid: string,
  input: {
    role: Role;
    /** role=client: link to this existing client. */
    clientId?: string | null;
    /** role=client: create a brand-new client with this name instead of linking. */
    newClientName?: string;
    /** role=employee: clients to assign. */
    assignedClientIds?: string[];
  },
) {
  const admin = await requireAdmin();
  const existing = await getUser(uid);
  if (!existing) throw new Error("User not found");

  const patch: Partial<AppUser> = {
    role: input.role,
    disabled: false,
    approvedAt: Date.now(),
    clientId: null,
    assignedClientIds: [],
  };

  if (input.role === "client") {
    let clientId = input.clientId ?? null;
    const newName = input.newClientName?.trim();
    if (newName) {
      clientId = await createClient({
        name: newName,
        website: "",
        industry: "",
        // Seed the contact with the client's own login email so meetings/assets auto-route.
        contactEmail: existing.email,
        domains: [],
        description: "",
        brandVoice: "",
        assignedEmployeeIds: [admin.uid],
        status: "active",
        createdAt: Date.now(),
        createdBy: admin.uid,
      });
    }
    if (!clientId) throw new Error("Pick a client or create a new one for this person.");
    patch.clientId = clientId;
  } else if (input.role === "employee") {
    patch.assignedClientIds = input.assignedClientIds ?? [];
  }

  await upsertUser({ ...existing, ...patch });
  await adminAuth().updateUser(uid, { disabled: false }).catch(() => {});
  revalidatePath("/registrations");
  revalidatePath("/team");
}

/** Reject a pending registration: remove the Firestore doc and the auth account. */
export async function rejectRegistrationAction(uid: string) {
  await requireAdmin();
  await deleteUser(uid);
  await adminAuth().deleteUser(uid).catch(() => {});
  revalidatePath("/registrations");
  revalidatePath("/team");
}

export async function updateTeamMemberAction(uid: string, patch: Partial<AppUser>) {
  await requireAdmin();
  const existing = await getUser(uid);
  if (!existing) throw new Error("User not found");
  await upsertUser({ ...existing, ...patch });
  if (patch.disabled !== undefined) {
    await adminAuth().updateUser(uid, { disabled: patch.disabled }).catch(() => {});
  }
  revalidatePath("/team");
}

/* ------------------------ client context ----------------------------- */

export async function deleteContextItemAction(id: string) {
  await requireStaff();
  const item = await getContextItem(id);
  if (!item) return;
  await deleteObject(item.storagePath);
  await deleteContextItem(id);
  revalidatePath(`/clients/${item.clientId}`);
}

export async function updateContextItemNoteAction(id: string, note: string) {
  await requireStaff();
  const item = await getContextItem(id);
  if (!item) throw new Error("Context item not found");
  await updateContextItem(id, { note: note.trim() });
  revalidatePath(`/clients/${item.clientId}`);
}

/* ------------------------- access tokens ----------------------------- */

/** Mint a personal access token for MCP clients. Returns the plaintext ONCE. */
export async function createAccessTokenAction(name: string) {
  const user = await requireStaff();
  const { id, token } = await issueAccessToken(user.uid, name);
  revalidatePath("/connect");
  return { id, token };
}

/** Revoke one of the caller's own tokens. */
export async function revokeAccessTokenAction(id: string) {
  const user = await requireStaff();
  const owned = await listAccessTokens(user.uid);
  if (!owned.some((t) => t.id === id)) throw new Error("Token not found");
  await updateAccessToken(id, { revoked: true });
  revalidatePath("/connect");
}
