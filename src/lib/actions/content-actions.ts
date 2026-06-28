"use server";

import { revalidatePath } from "next/cache";
import { getClient, upsertNewsletterConfig } from "@/lib/data";
import { startContentEngineRun } from "@/lib/content-engine/run";
import type { ContentFoundation, NewsletterBrand } from "@/lib/newsletter/types";
import { requireStaff } from "./_shared";

/* --------------------------- content engine -------------------------- */

/**
 * Trigger a native content-engine run for a client: picks the next on-brand
 * topic from the client's catalog (dedupe/cooldown via the ledger), generates a
 * QA-gated carousel, and lands it as a `review` asset. Returns immediately; the
 * carousel + slide images are produced in the background (after()).
 */
export async function runContentEngineAction(input: { clientId: string; format?: string }) {
  const user = await requireStaff();
  const result = await startContentEngineRun({
    clientId: input.clientId,
    format: input.format || null,
    actor: user,
  });
  revalidatePath("/jobs");
  revalidatePath(`/clients/${input.clientId}`);
  revalidatePath("/assets");
  return result;
}

/* ----------------------------- newsletter ---------------------------- */

/**
 * Save the onboarding questionnaire for a client: the brand (Bucket A) + the editorial
 * content foundation (Bucket B), as one merged `newsletterConfigs/{clientId}` doc. The
 * questionnaire sends the complete brand + foundation each save, so this is a full upsert.
 * Whether the config is "ready" is derived (missingBrandFields), not stored.
 */
export async function saveNewsletterConfigAction(
  clientId: string,
  input: { brand: NewsletterBrand; foundation: ContentFoundation },
) {
  await requireStaff();
  const client = await getClient(clientId);
  if (!client) throw new Error("Client not found");
  await upsertNewsletterConfig({
    clientId,
    brand: input.brand,
    foundation: input.foundation,
    updatedAt: Date.now(),
  });
  revalidatePath(`/clients/${clientId}/newsletter`);
  revalidatePath(`/clients/${clientId}`);
}

/** G0 cost guard — only opted-in clients are ever run by the weekly job. */
export async function setNewsletterOptInAction(clientId: string, optIn: boolean) {
  await requireStaff();
  const client = await getClient(clientId);
  if (!client) throw new Error("Client not found");
  await upsertNewsletterConfig({ clientId, optIn, updatedAt: Date.now() });
  revalidatePath(`/clients/${clientId}/newsletter`);
  revalidatePath(`/clients/${clientId}`);
}
