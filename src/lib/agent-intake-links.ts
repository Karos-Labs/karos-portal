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
 * caller already resolved (see `requireIntakeAgentAccess` in
 * agent-intake-views.ts) rather than resolving one itself, so the routing
 * decision stays pure and testable and the read stays where the page's other
 * reads are.
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
 * THE ARCHIVE IS A CALENDAR VIEW (portal feedback round 2, 2026-09): "Archive
 * does not need to be in settings, it's in the calendar." It was Account
 * Center's `?tab=archive` until this pass, and the Workspace board's own
 * `/tasks?tab=archive` before that — one list that has now outlived two homes,
 * which is the whole reason every caller asks this function instead of spelling
 * a URL.
 *
 * ONE VIEW, TWO ROUTES TO IT, split on the reader rather than on the list: the
 * flat `/calendar` scopes itself to the viewer's own client, so it is a
 * client's own calendar and the staff cross-client overview — which has no one
 * archive to show. Staff therefore get the client-scoped route. This is the
 * same split `toClientActions` makes for every other calendar row, and a
 * CLIENT_USER handed the scoped URL is redirected to the flat one with the
 * query intact, so a link pasted across readers still lands.
 *
 * The label moves with the READER too: "your archive" is client-voiced copy;
 * pointed at one client's calendar for a STAFF reader it would be telling them
 * this client's archive is theirs.
 */
export function clientArchiveLink(args: { clientId: string; isStaff: boolean }): {
  href: string;
  label: string;
} {
  return {
    href: args.isStaff ? `/clients/${args.clientId}/calendar?view=archive` : "/calendar?view=archive",
    label: args.isStaff ? "this client's archive" : "your archive",
  };
}

/* ────────── the one control that offers a viewer their agent ───────── */

/**
 * Where a control that offers a viewer their agent goes, and what it may say.
 *
 * FOUR CALL SITES, one answer (grep the name for today's list). It began as the
 * three intake pages' header control (#82). The Workspace activity tab's empty
 * state was found doing the same thing — "Run an agent →" over a hard-coded
 * `/clients/<id>/agents` (#92) — and asks this rather than being edited into a
 * fourth spelling of the same promise. Everything below is therefore a claim
 * about the DESTINATIONS, not about one page's header, which is what makes it
 * safe to ask from anywhere.
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
 * ONE WORD FOR BOTH ROLES (parity pass 2026-09). The two labels used to split
 * on the viewer — "All agents"/"Open the agent" for staff, "Your agents"/"Back
 * to the agent" for a client — with the arrow flipping too, so a staff member
 * previewing an intake page met a header control the client never gets, in a
 * different direction. The product owner's ruling is that staff read the
 * client's page; a staff extra has to be an ADDITIVE, marked block, and a
 * different word on a shared control is not additive, it is a divergence. Both
 * roles also reached this page the same way in practice — from the agent's own
 * detail page, which is where both roles' run gesture lives — so the client's
 * arrival word is the true one for either of them.
 *
 * `isStaff` is still taken rather than dropped: every caller resolves it for
 * its own guard anyway, and keeping it in the signature is what makes a future
 * re-split a visible edit here rather than a new ternary at six call sites.
 */
export function intakePageAction(args: {
  clientId: string;
  /** Unused since the parity pass — see the note above before re-reading it. */
  isStaff: boolean;
  /** This client's granted, enabled instance — see requireIntakeAgentAccess. */
  agentId: string | null;
}): { href: string; label: string; back: boolean } {
  // `back` is the ARROW'S direction, and it belongs to the LABEL rather than to
  // the viewer: only "Back to the agent" is a return, so only it earns a back
  // chevron. The roster branch is a forward move — a caller can reach it from a
  // surface that was never the agent's page (the Workspace timeline's empty
  // state does), and a left chevron there would point at a journey the reader
  // did not make. No arrows in the labels themselves: each caller draws the
  // icon this flag names.
  if (!args.agentId) {
    // No resolvable instance: name the roster, drop the verb.
    return {
      href: `/clients/${args.clientId}/agents`,
      label: "Your agents",
      back: false,
    };
  }
  return {
    href: `/clients/${args.clientId}/agents/${args.agentId}`,
    label: "Back to the agent",
    back: true,
  };
}
