"use server";

/**
 * The ClientSeat lifecycle's missing half: REMOVAL.
 *
 * A seat is one person on the client's team whose accounts we draft for, and it
 * is platform-agnostic by design — `addXSeatAction` and `addLinkedInSeatAction`
 * both reuse the same seat row when the person already has one, and attach one
 * more agent's intake to it. Until now nothing anywhere could take one back
 * (#84). A typo, a duplicate ("Dan" and "Daniel Herbert"), or someone who has
 * left became a permanent card on the client's own page — and worse than
 * cosmetic, because a seat with no intake document still gets a row in the agent
 * page's "What it runs on" band by design, so a dead seat permanently painted an
 * "Empty" badge and permanently inflated that band's "n of m still empty" line.
 *
 * This lives in its own module rather than in x-agent-actions.ts or
 * linkedin-agent-actions.ts precisely BECAUSE it is cross-agent: putting it in
 * one platform's file would say a seat belongs to that platform, which is the
 * thing the shared-seat model exists to deny.
 *
 * NOT the LinkedIn *employee* seat — that is a different collection with a
 * different price (see seat-actions.ts, and the divergence written up for
 * Daniel). Nothing here touches it.
 */

import { revalidatePath } from "next/cache";
import {
  deleteAgentIntake,
  deleteClientSeat,
  deleteXTakesForSeat,
  getClientSeat,
  listAgentIntake,
} from "@/lib/data";
import { deleteObject } from "@/lib/storage";
import { requireClientAccess } from "./_shared";
import type { AgentIntake } from "@/lib/types";

/**
 * Every intake family, derived so it cannot fall behind the union.
 *
 * A seat's answers can live under any agent, and removal has to reach all of
 * them — a family this list forgot would leave an orphan document that no
 * surface can show and that a re-add of the same name would inherit. Keyed as a
 * Record over `AgentIntake["agent"]` so widening that union is a COMPILE error
 * here rather than a silent omission at run time.
 */
const INTAKE_FAMILY_PRESENT: Record<AgentIntake["agent"], true> = {
  x: true,
  linkedin: true,
  reddit: true,
  // Newsletter has no per-seat concept — an issue goes out from the company,
  // never from a person — so this family never HAS a seat row. It is listed
  // anyway because the sweep's job is to leave no orphan behind, and "there are
  // none" is cheaper to prove by looking than to assume.
  newsletter: true,
  // Same as newsletter: the blog writes for the company, and its only scope
  // choice (company vs an executive byline) is a config field, not a seat. Listed
  // for the same reason — proving there are none beats assuming it.
  blog: true,
  // Same as the two above: a review is about the business, never a person, so
  // this family never HAS a seat row. Listed anyway, because the sweep's job is
  // to leave no orphan behind and "there are none" is cheaper to prove by
  // looking than to assume.
  reputation: true,
};
const INTAKE_FAMILIES = Object.keys(INTAKE_FAMILY_PRESENT) as Array<AgentIntake["agent"]>;

/**
 * Remove a seat and everything that hangs off it.
 *
 * WHAT GOES, and why each:
 *
 *  1. Every intake document for this seat, in EVERY family. Not just the family
 *     whose page the client pressed Remove on: a seat is the person, the add
 *     forms say so ("If they already have a seat for another agent, this adds
 *     LinkedIn to the same seat"), and a per-family removal would leave a row
 *     the other agent's page still lists with answers the client believes they
 *     deleted. The confirm copy states this outright.
 *  2. The private CV object behind a LinkedIn seat's `cvPath`. Deleting only the
 *     Firestore doc would leave that person's resume in the bucket with nothing
 *     left pointing at it — a document nobody can reach and nobody can delete.
 *  3. That seat's takes (X). They are inputs a run drafts from, and the band's
 *     take count is client-wide, so orphans would keep counting.
 *  4. The seat row itself, last, so a failure part-way through leaves a seat the
 *     client can still see and press Remove on again rather than a ghost whose
 *     documents nothing can reach.
 *
 * WHAT STAYS, deliberately:
 *
 *  • The draft-feedback log (`xDraftFeedback` and its LinkedIn/Reddit siblings).
 *    Those rows are what the agent learns from and they are keyed by `account`,
 *    which may be a seat id — deleting them would silently rewrite what the
 *    agent knows about the client's whole programme in order to remove one
 *    person. The intake surfaces already render an unmatched account id as
 *    "Seat", so the log reads as history rather than breaking.
 *  • Anything already SUBMITTED to the agent service. A run in flight carries
 *    its own copy of the payload, and the portal has no recall channel — so a
 *    run started before the removal can still return drafts for that person.
 *    That is stated in the confirm the client presses, not hidden: staff review
 *    every batch before a client sees it, which is where such a draft is caught.
 *
 * Returns the same `{ error?: string }` shape as its neighbours on these
 * surfaces, so the one intake-save funnel reads every result the same way.
 */
export async function removeClientSeatAction(input: {
  clientId: string;
  seatId: string;
}): Promise<{ removedName?: string; error?: string }> {
  // THROWS on a lapsed session, on a non-client role, and on a client reaching
  // for another client's id. The browser supplies both ids, so the seat is
  // re-read below and checked against this clientId — a client pairing a
  // foreign seat id with their own client id gets the not-found sentence.
  await requireClientAccess(input.clientId);

  const seat = await getClientSeat(input.seatId);
  if (!seat || seat.clientId !== input.clientId) {
    // One sentence for "gone" and for "not yours", so a client probing ids
    // cannot learn which seats exist elsewhere. It reads as the common case,
    // which is a second tab that already removed it.
    return { error: "That seat has already been removed." };
  }

  for (const family of INTAKE_FAMILIES) {
    const docs = (await listAgentIntake(input.clientId, family)).filter(
      (doc) => doc.seatId === input.seatId,
    );
    for (const doc of docs) {
      if (doc.cvPath) {
        // Best-effort: a bucket object that has already gone, or a storage
        // outage, must not strand the seat row. The Firestore delete below
        // removes the only pointer the PRODUCT has to it either way — which is
        // not the same as the bytes being gone, so a failure here leaves an
        // orphan in the bucket that no surface can reach and nothing will
        // retry. Worth knowing before treating this as a deletion guarantee.
        try {
          await deleteObject(doc.cvPath);
        } catch {
          // Non-fatal — see above.
        }
      }
      await deleteAgentIntake(doc.id);
    }
  }

  await deleteXTakesForSeat(input.clientId, input.seatId);
  await deleteClientSeat(input.seatId);

  // Both agent pages list the same seats, and both bands count them, so both
  // revalidate however the removal was reached.
  revalidatePath(`/clients/${input.clientId}/x-agent`);
  revalidatePath(`/clients/${input.clientId}/linkedin-agent`);
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { removedName: seat.name };
}
