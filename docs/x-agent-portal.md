# X agent (e13) — portal surfaces

How the X agent runs through this portal. Spec of record: the lab repo's
`docs/PORTAL-INPUT-CONTRACT.md` + `clients/karoslabs/internal/x-agent/PORTAL-BUILDOUT-BRIEF.md`.

## The one canonical set of X surfaces

| Surface | Where |
|---|---|
| Company-page form, seats ("add a seat"), what's-new box, per-seat takes box, per-draft feedback | `src/components/x-agent-intake.tsx`, rendered inside the run dialog on `/clients/<id>/agents` — inline on a first run, then collapsed behind the "X agent data" button on the agent card and at the top of the run brief — and by the `/clients/<id>/x-agent` deep link, which no navigation points at. Both get their props from `buildXAgentIntakeView` in `src/lib/agent-intake-views.ts` — one mapping, two mounts |
| Agent registration | `customAgents` doc, key `karos-x-agent` → `products/live/x-agent` (imported from the lab manifest) |
| Run launcher | `/clients/<id>/agents` (custom agents hub; X launch prompts in `src/components/custom-agents.tsx`) |
| Stored data | Firestore: `clientSeats`, `agentIntake` (agent="x"), `xNewsUpdates`, `xTakes`, `xDraftFeedback` — flat collections keyed by clientId/seatId |
| Run-time injection | `src/lib/agent-service/x-agent-context.ts` serializes the stored data to context files on every X run; they override any older repo copies |
| Live X reads | `XAI_API_KEY` via the platform secret store only (see `agent-service/DEPLOY.md` "X agent live reads"); never in a file |
| Review | Webhook → job status `review` + one library asset (type `note`, unpublishable — `PUBLISHABLE_PLATFORMS.note` has no targets, so nothing about the asset's own type changes). Draft-only is structural: a human always approves. See "Out of scope (parked)" below for the opt-in that can auto-publish an APPROVED single-post draft through the existing X integration |

Voice, pillars, cadence, language, launch-vs-ongoing are BUILT by the agent
(onboarding profile + the account's own posts + the edit loop) — the forms never
ask for them. Feedback is captured per account and serialized back into future
runs as that account's learning log; one account's corrections never bleed into
another's.

## Canonical instructions for the `karos-x-agent-v2` customAgents doc

The instructions text lives in ONE place: `scripts/promote-x-agent-v2.ts`
(`V2_INSTRUCTIONS`), which upserts the doc in both databases. This doc no
longer embeds a copy — an embedded copy is how the last drift happened: this
file said "a week of posts", the script said "N drafts of 5/10/21", and
neither matched the product.

The load-bearing rules of the current text, for a reader who needs the shape
without opening the script:

- **One run produces ONE post** (product ruling, 2026-08-11 — batches do not
  exist). One identity per run: the company page, or a single seat, read from
  the request; the company page when unnamed. One avenue, chosen by the
  request first, the identity's stated lane preference next, otherwise the
  identity's top-weighted lane. A thread is that one post.
- The lab repo's `SKILL.md` and its references still describe a batch of N
  (5/10/21); the instructions explicitly supersede that framing, and the
  lane-spanning batch rules do not apply to a one-post run. Retire the batch
  language upstream when the lab repo is next touched.
- The deliverable stays `client/DRAFTS.md` in the exact parsed structure
  ("# Account 1 · <name>" / "## Avenue 1 · <lane>" / the post as a "> "
  blockquote / a `NNN chars` line / "- **" source bullets) — `x-drafts.ts`
  and the review surfaces parse it. One account section, one avenue block.
- Portal context files override repo copies on any disagreement, and
  `prior-batch-*.md` files are this client's previous deliveries: everything
  in them is ALREADY USED.
- Requires the built client (X-FOUNDATION.md), else outcome `blocked_intake`.
  Draft-only, no images, and every x-craft.md / lanes.md gate applies.

Changing the text means editing the script and re-running it
(`npx tsx scripts/promote-x-agent-v2.ts` — it writes BOTH databases, so
snapshot the docs first; see `ROLLBACK.md`). The server-side ceiling that
backs the ruling is `X_V2_MAX_OUTPUTS_PER_RUN = 1` in
`src/lib/scheduled-runs.ts`, clamped at the submit core for every path.

## Out of scope (parked)

Auto-posting / X OAuth (`X_API_CLIENT_ID` etc.) as this agent's OWN posting
mechanism — still parked, and still true that the "X (Twitter)" integration
card was built for other content types.

**PARTIALLY IMPLEMENTED 2026-09-21, opt-in, per client:** that same "X
(Twitter)" integration card's existing OAuth connection (`publishers.ts`'s
`publishAssetToPlatform`, the same call "Publish Now" and the auto-cron use
for every other platform) can now carry this agent's drafts too, when a
client has explicitly turned it on. `ClientIntegration.agentAutoPublish`
(default OFF — see its doc comment in `src/lib/types.ts`) is a per-client,
per-platform flag toggled from ONE consolidated checklist on the client
settings Integrations tab ("Agent draft auto-publish" — `integrations-tab.tsx`),
listing every connected, publishable channel uniformly rather than a
one-off X control. Draft-only and the review step are UNCHANGED: a human
still approves every post (`approveAssetAction`) exactly as before. What
changes is only what happens the instant AFTER approval — with the flag on,
`autoPublishApprovedAgentDraft` (`src/lib/actions/asset-actions.ts`) hands
the approved draft to `publishAssetToPlatform` instead of leaving it for the
"Pick & post on X" hand-off (`x-drafts-review.tsx`); with the flag off (every
existing client, today), nothing changes at all.

Only a SINGLE, COMPANY-PAGE, plain post qualifies for the automatic hand-off
(`agentDraftAutoPublishTarget` in `src/lib/agent-draft-auto-publish.ts`):
 - a thread, a reply, or a quote-comment has no plain-tweet publish path
   today (`publishToTwitter` posts one bare 280-char tweet, no targeting, no
   chaining) and stays on the manual "Pick & post" flow, where X's own
   compose UI can actually address them;
 - a SEAT's draft stays manual too — the client's `twitter`
   `ClientIntegration` is one shared credential (the same one "Publish Now"
   already posts as), not one per seat, so a personal draft meant for that
   seat's own handle would otherwise risk going out under the wrong account.

This is still a narrower thing than "X OAuth posting" as a product feature:
it is one client-scoped opt-in riding the existing integration, not a new
auto-posting surface, new OAuth scopes, or a change to draft-only as this
agent's default.
