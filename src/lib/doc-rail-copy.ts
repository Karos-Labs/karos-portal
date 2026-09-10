/**
 * What a client is told about a context document they cannot read yet — the
 * document rail's copy for the state that is neither "here it is" nor "there is
 * nothing here" (pure and client-safe: this module imports nothing at all).
 *
 * WHAT WENT WRONG, because it is what the shape is chosen from. The rail drew a
 * placeholder row for any doc type that exists internally with no client-readable
 * copy, and the row was hard-coded "Rebuilding", with a tooltip saying "check
 * back shortly". Nothing on that path had ever asked whether a rebuild was
 * running. The condition is only "there is an internal twin and no usable client
 * one", which is equally true when the last cycle finished hours ago, when it
 * failed, and when the client-tier row is present but under 40 characters. The
 * one control that clears the row is Regenerate, gated `isAdmin && clientId` — so
 * the client was told to wait for something that was not happening, by a row with
 * no end.
 *
 * WHY IT IS NOT IN THE COMPONENT. `components/client-documents.tsx` reaches the
 * server-action barrel (`@/lib/actions` → `lib/data.ts` → `server-only`), so it
 * cannot be imported in a unit test, and every claim about its words would have
 * to be a source pin — "this string appears in the file", which a string in the
 * WRONG BRANCH satisfies. These two functions decide what the rail says, so they
 * live where the saying can be checked by calling it.
 *
 * SCOPE — stated, not counted. This owns the three-way state question and BOTH
 * things the rail says off it: the placeholder row's two strings and the
 * whole-list empty line. Their SENTENCES stay separate — "no documents at all"
 * and "this one document" are not the same thing to say, and a consolidation has
 * to be true at every site it takes over — but the QUESTION is one, so the list
 * and a row inside it cannot disagree about whether anything is happening.
 *
 * The empty line came here rather than staying inline for a second reason worth
 * recording: as JSX it was a ternary chain yielding capitalised prose off
 * `=== "running"` / `=== "failed"`, and `asset-status-registers.test.ts` sweeps
 * src/ for exactly that shape — correctly, since both words are also `JobStatus`
 * members and a chain has no keys to tell one domain from another. Renaming the
 * state literals would have dodged that guard; asking a function honours it.
 *
 * It does not own `context-doc-copy.ts`'s doc-type NAMES either; that is a
 * different question about the same rows.
 */

/**
 * The three answers to "is anything happening to this client's documents right
 * now".
 *
 * ORDER IS THE RULE, and it is why this is a function rather than two booleans
 * read separately at each site: a cycle in flight OUTRANKS the last one having
 * failed, because the failure it would otherwise report is the one this run is
 * retrying.
 */
export type DocsPipelineState = "running" | "failed" | "idle";

export function docsPipelineState(opts: {
  isAiProcessing?: boolean;
  aiProcessingFailed?: boolean;
}): DocsPipelineState {
  if (opts.isAiProcessing) return "running";
  if (opts.aiProcessingFailed) return "failed";
  return "idle";
}

/**
 * The one line under the heading when the client has NO readable documents at
 * all — lifted verbatim from the rail, where the same three-way branch was
 * already spelled (QA F69: one line used to cover all three situations, so a
 * client who finished onboarding half an hour ago was told to finish
 * onboarding, and a failed run said the same thing).
 *
 * Different subject from `unavailableDocCopy`, and therefore different
 * sentences: this is about the whole list being empty, that is about one
 * document among several that are readable.
 */
export function docListEmptyLine(state: DocsPipelineState): string {
  if (state === "running") {
    return "Karos Agents are writing your documents now — this takes a few minutes.";
  }
  if (state === "failed") return "Generation stopped early. Your Karos team is on it.";
  return "Your brand and strategy documents will appear here once onboarding completes.";
}

/**
 * What ONE unreadable document says: a short state word for the row's right
 * edge, and the sentence that gives the row an end.
 *
 * EVERY BRANCH ENDS SOMEWHERE, and only one of them may promise that waiting
 * works — the one where a rebuild is actually in flight. The other two name the
 * single action a client has, which is asking their team, and it is the same end
 * the rail's own empty-document overlay already offers ("ask your Karos team to
 * regenerate it").
 *
 * NO CLAIM THAT ANYONE HAS BEEN TOLD. Nothing on this path notifies staff — no
 * email, no task, no activity row — so the copy asks the client to do the
 * telling rather than promising something the code does not do.
 */
export function unavailableDocCopy(state: DocsPipelineState): { state: string; hint: string } {
  if (state === "running") {
    return {
      state: "Rebuilding",
      hint: "Karos Agents are rebuilding your documents now — check back shortly.",
    };
  }
  if (state === "failed") {
    return {
      state: "Not ready",
      hint: "The last rebuild stopped early — ask your Karos team to run it again.",
    };
  }
  return {
    state: "Not ready",
    hint: "Your copy of this document isn't ready yet — ask your Karos team to rebuild it.",
  };
}
