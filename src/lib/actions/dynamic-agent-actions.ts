"use server";

import { revalidatePath } from "next/cache";
import {
  createDynamicAgentSpec,
  deleteDynamicAgentSpec,
  getDynamicAgentSpec,
  updateDynamicAgentSpec,
} from "@/lib/data";
import type {
  DynamicAgentInputDef,
  DynamicAgentInputValue,
  DynamicAgentSpec,
  DynamicAgentStepDef,
} from "@/lib/types";
import {
  validateAndNormalizeInputSchema,
  validateAndNormalizeSteps,
  validateGeneral,
  type DynamicAgentGeneralInput,
} from "@/lib/dynamic-agent-validation";
import { checkDanglingReferences } from "@/lib/dynamic-agent-reference-check";
import { generateDynamicAgentDraft, MAX_GENERATION_DESCRIPTION_CHARS } from "@/lib/dynamic-agent-generation";
import { submitDynamicAgentJob } from "@/lib/jobs/submit-custom";
import { requireAdmin, requireClientAccess } from "./_shared";

/**
 * Server actions for the Agent Studio (`/admin/agents/builder/**`).
 *
 * // DECISION: the entire Agent Studio and all of its server actions are
 * ADMIN-ONLY, and the check is enforced server-side inside EVERY action below
 * via `requireAdmin()` — not only by hiding the entry point in the UI, because
 * a non-admin session can invoke a server action directly. (The per-agent
 * client fence, `allowedClientIds`, is a different gate and lives in the
 * job-creation path — see submitDynamicAgentJob.)
 *
 * The actual validation/normalization rules live in
 * `lib/dynamic-agent-validation.ts` (pure, unit-tested on its own) — this
 * file only adds the server-only pieces around them: auth, Firestore reads
 * and writes, cache invalidation.
 *
 * // NOTE: this file must not re-export the `DynamicAgentGeneralInput` type
 * (even as a type-only export) — Next 16's "use server" action transform
 * mis-registers type-only exports from action files as server action
 * references, producing a `ReferenceError: ... is not defined` at runtime.
 * Consumers should import the type directly from
 * `@/lib/dynamic-agent-validation` instead.
 */

/* ─────────────────────────── admin CRUD ─────────────────────────── */

export async function createDynamicAgentSpecAction(
  input: DynamicAgentGeneralInput,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const user = await requireAdmin();
  const error = validateGeneral(input);
  if (error) return { ok: false, error };
  const now = Date.now();
  const id = await createDynamicAgentSpec({
    name: input.name.trim(),
    ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    description: input.description.trim(),
    category: input.category.trim(),
    icon: input.icon.trim(),
    creditsCost: input.creditsCost,
    active: input.active,
    version: 1,
    allowedClientIds: input.allowedClientIds ?? [],
    // Explicit boolean, never the wire value's truthiness — a saved spec is
    // never ambiguous about whether de-duplication is on.
    dedupeAgainstHistory: input.dedupeAgainstHistory === true,
    inputSchema: [],
    steps: [],
    createdAt: now,
    updatedAt: now,
    createdBy: user.uid,
  });
  revalidatePath("/admin/agents/builder");
  return { ok: true, id };
}

/**
 * One update action for the whole Studio: General Settings (Phase 2), the
 * Input Schema Builder (Phase 3) and the Pipeline Builder (Phase 5) each save
 * through this same action with only their own slice populated, so a partial
 * save from one tab never clobbers another tab's unsaved-elsewhere state —
 * and every save still goes through ONE version bump / admin re-check, not
 * three copies of it.
 */
export interface DynamicAgentSpecPatch {
  general?: DynamicAgentGeneralInput;
  inputSchema?: DynamicAgentInputDef[];
  steps?: DynamicAgentStepDef[];
}

export async function updateDynamicAgentSpecAction(
  id: string,
  patch: DynamicAgentSpecPatch,
): Promise<{ ok: boolean; error?: string; version?: number; warning?: string }> {
  const user = await requireAdmin();
  const existing = await getDynamicAgentSpec(id);
  if (!existing) return { ok: false, error: "Agent not found." };

  const update: Partial<Omit<DynamicAgentSpec, "id">> = {};

  if (patch.general) {
    const error = validateGeneral(patch.general);
    if (error) return { ok: false, error };
    update.name = patch.general.name.trim();
    // Cleared deliberately when the admin empties the field, so a stale one-liner
    // cannot outlive the edit that removed it.
    update.summary = patch.general.summary?.trim() || "";
    update.description = patch.general.description.trim();
    update.category = patch.general.category.trim();
    update.icon = patch.general.icon.trim();
    update.creditsCost = patch.general.creditsCost;
    update.active = patch.general.active;
    update.allowedClientIds = patch.general.allowedClientIds ?? [];
    update.dedupeAgainstHistory = patch.general.dedupeAgainstHistory === true;
  }

  if (patch.inputSchema) {
    const result = validateAndNormalizeInputSchema(patch.inputSchema);
    if (!result.ok) return { ok: false, error: result.error };
    update.inputSchema = result.inputSchema;
  }

  if (patch.steps) {
    const result = validateAndNormalizeSteps(patch.steps);
    if (!result.ok) return { ok: false, error: result.error };
    update.steps = result.steps;
  }

  // Non-blocking: a dangling {{inputs.KEY}}/{{outputs.STEP_ID}} reference does
  // not fail the save (that would break every spec written before this check
  // existed) — it surfaces as a warning the admin can act on or ignore. Only
  // checked when this save actually touches the input schema or the pipeline;
  // a general-settings-only save has nothing new to warn about.
  let warning: string | undefined;
  if (patch.inputSchema || patch.steps) {
    const messages = checkDanglingReferences(
      update.inputSchema ?? existing.inputSchema,
      update.steps ?? existing.steps,
    );
    if (messages.length > 0) warning = messages.join(" ");
  }

  const nextVersion = existing.version + 1;
  await updateDynamicAgentSpec(id, {
    ...update,
    version: nextVersion,
    updatedAt: Date.now(),
    updatedBy: user.uid,
  });
  revalidatePath("/admin/agents/builder");
  revalidatePath(`/admin/agents/builder/${id}`);
  return { ok: true, version: nextVersion, ...(warning ? { warning } : {}) };
}

export async function deleteDynamicAgentSpecAction(id: string): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const existing = await getDynamicAgentSpec(id);
  if (!existing) return { ok: false, error: "Agent not found." };
  await deleteDynamicAgentSpec(id);
  revalidatePath("/admin/agents/builder");
  return { ok: true };
}

/** Fast one-click Active/Inactive flip for the Studio's list page. */
export async function setDynamicAgentSpecActiveAction(
  id: string,
  active: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireAdmin();
  const existing = await getDynamicAgentSpec(id);
  if (!existing) return { ok: false, error: "Agent not found." };
  await updateDynamicAgentSpec(id, {
    active,
    version: existing.version + 1,
    updatedAt: Date.now(),
    updatedBy: user.uid,
  });
  revalidatePath("/admin/agents/builder");
  return { ok: true };
}

/* ─────────────────────── free-text spec generation ─────────────────────── */

/**
 * Generates a complete draft input schema + step pipeline from an admin's
 * free-text description of the agent they want. Internal AUTHORING tool, not
 * a client-facing run: `requireAdmin()` gates it like the rest of the Studio,
 * and it never charges credits (see generateDynamicAgentDraft's own doc
 * comment for why).
 *
 * // DECISION: the result is NEVER written to Firestore here. This action
 * only returns a draft for the editor to hold as unsaved state; the admin
 * saves it through the normal updateDynamicAgentSpecAction path (or discards
 * it) exactly like a hand-built pipeline. A generation that auto-saved could
 * silently overwrite a working agent with no way back — there is no spec
 * history beyond `version`.
 */
export async function generateDynamicAgentDraftAction(input: {
  description: string;
  specId?: string;
}): Promise<
  { ok: true; inputSchema: DynamicAgentInputDef[]; steps: DynamicAgentStepDef[]; notes: string[] } | { ok: false; error: string }
> {
  await requireAdmin();

  const description = input.description.trim();
  if (!description) return { ok: false, error: "Describe the agent you want before generating." };
  if (description.length > MAX_GENERATION_DESCRIPTION_CHARS) {
    return {
      ok: false,
      error: `Description is too long (max ${MAX_GENERATION_DESCRIPTION_CHARS.toLocaleString()} characters).`,
    };
  }

  const result = await generateDynamicAgentDraft(description);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, inputSchema: result.inputSchema, steps: result.steps, notes: result.notes };
}

/* ─────────────────────── client-facing run action ─────────────────────── */

/**
 * Fires a dynamic agent for a client from its intake form
 * (dynamic-agent-intake-form.tsx). Thin wrapper around
 * submitDynamicAgentJob (submit-custom.ts) — `requireClientAccess` is the
 * SAME gate every other client-triggered run in this codebase uses (staff:
 * any client; a CLIENT_USER: only their own), separate from the spec-level
 * `allowedClientIds` fence that submitDynamicAgentJob itself enforces.
 */
export async function runDynamicAgentAction(
  specId: string,
  clientId: string,
  inputs: Record<string, DynamicAgentInputValue>,
): Promise<{ jobId?: string; error?: string }> {
  const user = await requireClientAccess(clientId);
  return submitDynamicAgentJob(user, { specId, clientId, inputs });
}
