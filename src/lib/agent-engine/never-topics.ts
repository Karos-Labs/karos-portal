import "server-only";

import { readLearningPreferences } from "./learning-feedback";
import { parseForbiddenTopics } from "@/lib/dynamic-agent-guardrails";
import type { Client } from "@/lib/types";

/**
 * ── TWO LISTS OF THINGS NOT TO WRITE ABOUT, AND ONLY ONE WAS ENFORCED. ──
 * (SCRUM-468, bullet 4.)
 *
 * `client.forbiddenTopics` is the portal's: staff or the client type it on the
 * client editor, and the dynamic-agent guardrail vets every finished
 * deliverable against it — a violation BLOCKS the run and refunds the client
 * (`docs/dynamic-agent-guardrails.md` §2.3).
 *
 * `neverTopics` in the middleware's `client_preferences` is the loop's: it is
 * written from the review surfaces, projected into every run's prompt, and
 * carried by C7 §2.4. A client who told us "never write about our pricing" in
 * review had it reach the prompt as an instruction and reach the vet as
 * nothing at all — so a run that ignored the instruction was blocked by
 * nobody, and the one guardrail that can actually stop a post never saw the
 * topic the client cared most about.
 *
 * This is the union, read at submit time.
 *
 * ── WHY IT IS A UNION AND NOT A SYNC. ──
 *
 * The obvious reading of the ticket is to mirror `neverTopics` INTO the stored
 * `client.forbiddenTopics`. Deliberately not done. The two lists have
 * different owners and one flat array cannot say which row came from where, so
 * a mirror has to choose between two failure modes: overwrite, and a
 * staff-curated list is silently erased by a background job; or append, and a
 * never-topic the client later withdrew in review can never be removed,
 * because nothing can tell it apart from one somebody typed. A read at submit
 * time has neither problem — the middleware stays the owner of its list, the
 * portal stays the owner of its own, and a withdrawal takes effect on the next
 * run.
 *
 * The cost is that the client editor still shows only the portal's half. That
 * is a display gap, and the alternative was a write that can destroy a list
 * nobody can reconstruct.
 *
 * Best-effort, like every other read of the control plane in this directory: a
 * middleware that is down leaves the run with the portal's list, which is
 * exactly the behaviour every run has had until now.
 */
export async function effectiveForbiddenTopics(
  client: Pick<Client, "agentsRepoSlug" | "forbiddenTopics">,
): Promise<string[]> {
  const portal = Array.isArray(client.forbiddenTopics) ? client.forbiddenTopics : [];
  const preferences = await readLearningPreferences(client);
  if (!preferences || preferences.neverTopics.length === 0) return portal;

  // Through the editor's OWN parser rather than a second normaliser: it
  // already trims, drops blanks, de-duplicates case-insensitively keeping the
  // first spelling, and applies the per-client cap. "Pricing" typed here and
  // "pricing" recorded in review are one rule, which is what stops the same
  // constraint reaching the vet twice and being counted twice in the
  // guardrail report.
  //
  // The portal's rows go in FIRST, so the first spelling that survives is the
  // one somebody typed, and if a client ever reaches the cap what falls off
  // the end is the newest never-topic rather than a curated rule.
  return parseForbiddenTopics([...portal, ...preferences.neverTopics].join("\n"));
}
