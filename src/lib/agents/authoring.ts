import "server-only";

import { createAgent, updateAgent } from "@/lib/data";
import type { Agent, AgentField } from "@/lib/types";
import { MODELS } from "@/lib/constants";

/**
 * Shared agent-authoring building blocks used by BOTH the web server actions
 * (`src/lib/actions.ts`, cookie-authed) and the MCP server
 * (`src/app/api/[transport]/route.ts`, token-authed). Plain server functions —
 * no `"use server"`, no cookies, no `revalidatePath`. Callers own auth + cache.
 */

/** Everything the agent builder / MCP client can set. Lifecycle is managed separately. */
export type DraftFields = Pick<
  Agent,
  "name" | "description" | "icon" | "color" | "model" | "outputKind" | "systemPrompt" | "capabilities" | "fields" | "shared"
>;

/** Normalise field state — coerce comma-string select options into arrays, sanitise keys. */
export function cleanFields(fields: AgentField[]): AgentField[] {
  return fields.map((f) => {
    const { options: _options, ...rest } = f;
    const clean: AgentField = {
      ...rest,
      key: f.key.trim().replace(/\s+/g, "_") || "field",
    };
    // Only "select" fields carry options; never write `undefined` (Firestore rejects it).
    if (f.type === "select") {
      clean.options =
        typeof f.options === "string"
          ? (f.options as string).split(",").map((s) => s.trim()).filter(Boolean)
          : f.options ?? [];
    }
    return clean;
  });
}

/** Every agent must be able to generate; keep that capability present. */
export function withGenerate(caps: Agent["capabilities"]): Agent["capabilities"] {
  return caps.includes("generate") ? caps : ["generate", ...caps];
}

/** Create an in-development draft. Returns the new agent id. */
export async function createDraftAgent(uid: string, initial: Partial<DraftFields>): Promise<string> {
  const now = Date.now();
  return createAgent({
    name: initial.name ?? "",
    description: initial.description ?? "",
    icon: initial.icon ?? "Sparkles",
    color: initial.color ?? "#2dff9e",
    model: initial.model ?? MODELS.SONNET,
    outputKind: initial.outputKind ?? "freeform",
    systemPrompt: initial.systemPrompt ?? "",
    fields: initial.fields ? cleanFields(initial.fields) : [],
    capabilities: withGenerate(initial.capabilities ?? ["generate"]),
    status: "draft",
    isActive: false,
    shared: initial.shared ?? true,
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  });
}

/** Merge-save a draft's working state. */
export async function saveAgentDraft(id: string, patch: Partial<DraftFields>): Promise<void> {
  const clean: Partial<Agent> = { ...patch, updatedAt: Date.now() };
  if (patch.fields) clean.fields = cleanFields(patch.fields);
  if (patch.capabilities) clean.capabilities = withGenerate(patch.capabilities);
  await updateAgent(id, clean);
}

/** Publish a draft into a live, runnable agent. Validates required fields. */
export async function publishAgent(id: string, fields: DraftFields): Promise<void> {
  if (!fields.name.trim()) throw new Error("Give your agent a name before publishing.");
  if (!fields.systemPrompt.trim()) throw new Error("Add a system prompt before publishing.");
  await updateAgent(id, {
    ...fields,
    name: fields.name.trim(),
    description: fields.description.trim(),
    systemPrompt: fields.systemPrompt.trim(),
    fields: cleanFields(fields.fields),
    capabilities: withGenerate(fields.capabilities),
    status: "published",
    isActive: true,
    updatedAt: Date.now(),
  });
}

/** Send a live agent back to in-development. Drafts are never "active" (runnable). */
export async function unpublishAgent(id: string): Promise<void> {
  await updateAgent(id, { status: "draft", isActive: false, updatedAt: Date.now() });
}

/** Build an ephemeral Agent from a draft config for a sandboxed test run (never persisted). */
export function buildTestAgent(uid: string, config: DraftFields): Agent {
  const now = Date.now();
  return {
    id: "test",
    ...config,
    fields: cleanFields(config.fields),
    capabilities: withGenerate(config.capabilities),
    status: "draft",
    isActive: false,
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  };
}
