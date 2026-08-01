/**
 * Where the three intake surfaces (X e13, LinkedIn e10, Reddit e15) point, and
 * where other surfaces point INTO them.
 *
 * Client-safe on purpose (no `server-only`): the anchors are rendered by the
 * intake components in the browser and consumed by the agent detail page's
 * inputs band on the server, and the two have to agree byte for byte. A rule
 * that has to hold on both sides of the RSC boundary gets ONE home, or it gets
 * two spellings that drift — which is what the anchor pairing below exists to
 * prevent.
 *
 * Nothing here reads Firestore. `intakePageAction` is handed the agent id its
 * caller already resolved (see `intakeAgentPageId` in agent-intake-views.ts)
 * rather than resolving one itself, so the routing decision stays pure and
 * testable and the read stays where the page's other reads are.
 */

/* ─────────────────── anchors: one row, one place to land ────────────────── */

/**
 * The DOM id an intake row's own card carries, derived from the row id
 * `toAgentInputRows` mints for it.
 *
 * The inputs band on the agent's page ("What it runs on") tells the reader to
 * open any of its rows. Its rows used to be plain `<li>`s with a hover border
 * and nothing to click, and the one real link went to the top of the intake
 * page with nothing identifying the row — worst exactly when the state was
 * worst, since a client with four empty seats clicked the empty seat and got
 * nothing (#85). Both sides now derive the target from the same row id through
 * this function, so a row can only lose its landing place by losing its id.
 *
 * `intake-` prefixed rather than the bare row id because "company" and "news"
 * are ordinary words that another element on those pages could plausibly claim.
 */
export function intakeAnchorId(rowId: string): string {
  return `intake-${rowId}`;
}

/**
 * The anchor for one seat's card.
 *
 * Spelled here rather than at the call sites because the seat row's id is
 * COMPOSED (`seat-${seat.id}` in toAgentInputRows) and the composition is the
 * part that can silently come apart: the band would build `#intake-seat-abc`
 * while the card rendered `#intake-abc`, and a hash that matches nothing scrolls
 * nowhere without erroring. The pairing is asserted directly in
 * agent-intake-anchors.test.ts.
 */
export function intakeSeatAnchorId(seatId: string): string {
  return intakeAnchorId(`seat-${seatId}`);
}

/** The band's link for one row: the intake page, at that row's own card. */
export function intakeRowHref(pageHref: string, rowId: string): string {
  return `${pageHref}#${intakeAnchorId(rowId)}`;
}

/* ────────────────── the archive link inside the feedback box ────────────── */

/**
 * The archive a reader of an intake page can actually reach.
 *
 * `?tab=archive` is read only by ProgressView, and TasksBody mounts
 * ProgressView only when a client is IN SCOPE. All three intake pages are
 * staff-reachable, and all three hard-coded the flat `/tasks?tab=archive` — so
 * a staff viewer fell through to the cross-client branch and got a bare board
 * under "Every client's board in one place": no archive, no tabs, and no way to
 * reach the archive of the client whose page the link was on (#90). A client's
 * own `/tasks` IS their scope, so their link was right and stays unchanged.
 *
 * The label moves with the destination. "your archive" is client-voiced copy
 * and reads as the READER's archive; pointed at one client's workspace it would
 * be telling a staff member that this client's archive is theirs.
 */
export function clientArchiveLink(args: { clientId: string; isStaff: boolean }): {
  href: string;
  label: string;
} {
  return args.isStaff
    ? { href: `/clients/${args.clientId}/tasks?tab=archive`, label: "this client's archive" }
    : { href: "/tasks?tab=archive", label: "your archive" };
}

/* ─────────────── the intake page's own navigation control ──────────────── */

/**
 * The one control in an intake page's header, per role.
 *
 * It said "Run the agent →" to everyone and went to `/clients/<id>/agents`.
 *
 * THAT PROMISE IS WRONG FOR BOTH ROLES, and the first fix here only noticed the
 * client half. It claimed "for staff that is right — the staff branch of that
 * page carries the run dialog". It does not: CD-I1 moved every staff run gesture
 * off the roster and onto the agent's own detail page, and that page says so in
 * its own comments ("both fed the run DIALOG, and CD-I1 moved every staff run
 * gesture to the agent detail page"). Its staff branch renders a header, the lab
 * import and bulk-upload buttons, a replan button, a settings link, a bind
 * control that binds rather than runs, a grid of link cards, and a read-only run
 * history. No run control anywhere — the same page the client branch refuses to
 * put one on. So a staff member read a verb the destination could not honour,
 * exactly like the client, and the fix that closed the client half PINNED the
 * false claim for the other.
 *
 * For a CLIENT it was a promise the destination is built to refuse: the
 * client branch of that page states the rule in its own comment ("No Run button
 * anywhere: a client's run gesture lives only inside a detail page") and
 * renders a header and a roster, nothing else (#82). It was backwards as
 * navigation too — the client REACHED the intake page from the agent's detail
 * page, and this sent them to that page's parent.
 *
 * So BOTH roles are sent to the agent's own page, where the run gesture actually
 * lives for either of them. `agentId` is null when the caller could not resolve
 * one it is sure the viewer may open, and the label drops the promise with the
 * destination rather than keeping it over a roster: naming the roster honestly
 * is worth more than a verb the page cannot honour.
 *
 * The two roles still differ in the WORD, because they arrive differently: a
 * client reached the intake page FROM the agent's detail page, so "Back to the
 * agent" is where they came from; a staff member typically did not, so theirs
 * names the destination instead.
 */
export function intakePageAction(args: {
  clientId: string;
  isStaff: boolean;
  /** This client's granted, enabled instance of this agent — see intakeAgentPageId. */
  agentId: string | null;
}): { href: string; label: string } {
  if (!args.agentId) {
    // No resolvable instance for either role: name the roster, drop the verb.
    return {
      href: `/clients/${args.clientId}/agents`,
      label: args.isStaff ? "All agents →" : "Your agents →",
    };
  }
  return {
    href: `/clients/${args.clientId}/agents/${args.agentId}`,
    label: args.isStaff ? "Open the agent →" : "Back to the agent →",
  };
}
