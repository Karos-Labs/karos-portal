"use server";

import { revalidatePath } from "next/cache";

import { getAgentSlot, getClientAgent, updateAgentSlot } from "@/lib/data-client-agents";
import { resolveUmbrellaSchedule } from "@/lib/client-agent-slots";
import { clientAgentRunRefusal } from "@/lib/client-agent-gate";
import { canNoteSlot, clampSlotNote, MAX_SLOT_NOTE_CHARS } from "@/lib/slot-notes";
import { dateKeyInZone } from "@/lib/client-agents";
import { runtimeTimeZone } from "@/lib/run-cadence";
import { logActivity, requireClientAccess } from "./_shared";

/**
 * A note on one day of the plan (§4.3, CD-A3).
 *
 * One note per slot: an edit REPLACES it rather than appending, because a
 * thread of instructions about a single post is not something a human applying
 * it on the day can act on — the client's latest intention is the whole of what
 * matters. Author and time are kept so staff know who asked and when.
 *
 * The day boundary is read in the SCHEDULE's zone, not the container's (the
 * F108 contract): a client in Tel Aviv writing a note at 8am for today's post
 * must not be told the day has passed because the server is already tomorrow.
 */
export async function setAgentSlotNoteAction(input: {
  clientId: string;
  slotId: string;
  text: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);

  const slot = await getAgentSlot(input.slotId);
  // Same answer for "missing" and "another client's": the browser supplies the
  // id, so a foreign slot must not confirm that it exists.
  if (!slot || slot.clientId !== input.clientId) return { error: "That day isn't on your plan." };

  const umbrella = await getClientAgent(slot.clientAgentId);
  if (!umbrella || umbrella.clientId !== input.clientId) {
    return { error: "That day isn't on your plan." };
  }

  // §2 guard rail, same predicate as every other client write against an
  // umbrella: a plan for an agent nobody has finished setting up is not a plan
  // the client should be annotating.
  const blocked = await clientAgentRunRefusal({
    user,
    clientId: input.clientId,
    customAgentId: umbrella.customAgentId,
  });
  if (blocked) return { error: blocked };

  const schedule = await resolveUmbrellaSchedule(umbrella);
  const zone = schedule?.timeZone ?? runtimeTimeZone();
  const gate = canNoteSlot(slot, dateKeyInZone(Date.now(), zone));
  if (!gate.ok) return { error: gate.reason };

  const text = clampSlotNote(input.text);
  const now = Date.now();

  if (!text) {
    // Clearing is a real intention, not an error: the client changed their mind
    // about a day they had annotated.
    await updateAgentSlot(slot.id, { note: null });
    revalidatePath(`/clients/${input.clientId}/agents`);
    return {};
  }

  await updateAgentSlot(slot.id, {
    note: {
      text,
      authorUid: user.uid,
      authorName: user.name,
      authorRole: user.role === "CLIENT_USER" ? "client" : "staff",
      createdAt: now,
      // Consumption is stamped by whoever applies it. Cleared on every edit:
      // a rewritten note has NOT been applied, whatever was true of the old one.
      consumedAt: null,
      consumedByJobId: null,
    },
  });

  // The fallback path that actually ships (§4.3 path 3): the note is surfaced
  // to staff, who fold it into that day's post. The activity log is the seam
  // that reaches them — there is no notifications collection in this codebase,
  // the bell is a derived feed, so inventing a notification primitive for one
  // alert would be a bigger change than the feature.
  void logActivity({
    clientId: input.clientId,
    timestamp: now,
    type: "CAMPAIGN_CREATED",
    title: `Note for ${slot.dateKey} · ${umbrella.displayName}`,
    actor: user.name,
    actorRole: user.role === "CLIENT_USER" ? "client" : "staff",
    metadata: {
      clientAgentId: umbrella.id,
      slotId: slot.id,
      dateKey: slot.dateKey,
      note: text.slice(0, MAX_SLOT_NOTE_CHARS),
    },
  });

  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}

/**
 * Staff mark a note as applied — the honest end of path 3.
 *
 * Until day-of generation consumes notes directly (Tomer seam T3), a human is
 * what "consumed" means, so a human is who stamps it. The client's echo line
 * changes from "your Karos team factors this in" to "applied", which is the
 * difference between a promise and a receipt.
 */
export async function markSlotNoteAppliedAction(input: {
  clientId: string;
  slotId: string;
}): Promise<{ error?: string }> {
  const user = await requireClientAccess(input.clientId);
  if (user.role === "CLIENT_USER") {
    return { error: "Only your Karos team can mark a note applied." };
  }
  const slot = await getAgentSlot(input.slotId);
  if (!slot || slot.clientId !== input.clientId) return { error: "That day isn't on your plan." };
  if (!slot.note) return { error: "There is no note on that day." };
  if (slot.note.consumedAt) return {};

  await updateAgentSlot(slot.id, {
    note: { ...slot.note, consumedAt: Date.now(), consumedByJobId: null },
  });
  revalidatePath(`/clients/${input.clientId}/agents`);
  return {};
}
