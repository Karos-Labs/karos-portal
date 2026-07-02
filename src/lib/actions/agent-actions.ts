"use server";

import { revalidatePath } from "next/cache";
import {
  updateAgent,
  deleteAgent,
  getAgent,
  getClient,
} from "@/lib/data";
import { startAgentRun, testRunAgent, type TestRunResult } from "@/lib/agents/run";
import {
  type DraftFields,
  createDraftAgent,
  saveAgentDraft,
  publishAgent,
  unpublishAgent,
  buildTestAgent,
} from "@/lib/agents/authoring";
import { requireStaff } from "./_shared";

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

export async function runAgentAction(input: {
  agentId: string;
  clientId: string;
  input: Record<string, string>;
}) {
  const user = await requireStaff();
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
