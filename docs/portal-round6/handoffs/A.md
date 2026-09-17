# Handoff from package A (primitives and the interaction sweep)

Nothing here blocks A. Each item is a change in a file A does not own.

## 1. `.focus-ring` is live — use the class name, not a new recipe

`src/app/globals.css` now defines `--focus: var(--foreground)` and one utility:

```css
.focus-ring:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }
```

It is UNLAYERED, so it beats any Tailwind `outline-none` that arrives later in a
class list, and it reverses with light mode for free. Every interactive element
in every package should carry `focus-ring` and should NOT carry
`focus-visible:ring-*`, `focus-visible:outline-none` or `ring-neon`.

Applied by `Button`, `Input`, `Textarea`, `Select`, `TabButton`, so anything
built out of those needs nothing extra.

- **B**: sidebar rows (`client-rail-agents-nav.tsx`), `agent-star-button.tsx`,
  and the status line's fact links.
- **C**: the ladder rows, `<HereFor>`'s "Got it", the document foot's "Looks
  right" / "Something is off".
- **D**: the run dialog's "Try:" chips, the `More options` disclosure, the
  "Change" text control.
- **E**: the bell's rows and "Mark all as read"; `client-suggestions.tsx`;
  `visibility-work.tsx`'s "Open {agent}" links.
- **F**: the roster row.

## 2. `Button` lost the lift, the shadow bloom and the trailing glyph

`primary` hovers to 90% of its own fill, `accent` to `--neon-bright`, in 150ms,
and neither moves. If any of your call sites renders a glyph AFTER a button label
(`<Icon name="ArrowRight" />`, `→` as a character), it goes: rule 3. A trailing
`ChevronRight` belongs to a row that navigates, not to a button.

## 3. `Card` no longer hovers, in all 52 files that use it

`hover:border-border-strong hover:shadow-[var(--shadow-2)]` is gone from the
primitive. **If a card is the whole target of a link, it must ask for its hover
back on its own className** — `clients-grid.tsx` already does exactly this
(`<Card className="h-full hover:border-border-strong">`) and is the pattern to
copy. F's roster row is the one client-facing surface where this matters; it is a
row rather than a card now, so `row-lift` is the right answer there instead.

Staff surfaces (`/admin/*`, `/jobs`, `/team`) lose the hover too. That is
intended (risk-review §F asks for a visual sweep), not a regression to patch per
file.

## 4. Two anchors were added for Home's SEO cells

`seo-geo-panel.tsx` now writes `id="presence"` (the "Do buyers find you?" card)
and `id="share"` (the roster-share block inside it), both `scroll-mt-24`.
`home-standing.tsx` builds `${href}#presence` and `${href}#share` from the `href`
prop it already receives.

- **C** (`app/(app)/clients/[id]/page.tsx`): `reportHref` must stay
  `/clients/${id}/settings?tab=reporting` with NO fragment of its own. If it ever
  grows one, those two cell links break silently.
- **E** (`settings/page.tsx`): the panel that carries these ids must keep
  rendering on the Reporting tab for a client. If the presence section is ever
  gated, tell A and the two Home cells lose their anchors (they keep the link).

## 5. Left for E, from think-home §1.5

The reputation pointer link at `settings/page.tsx:560-568` is a text link wearing
a chevron that turns orange on hover. §1.5 asks for a quiet link with an ink
hover; E's §3 deletes `reputationBubble` and both mounts, which settles it. If E
keeps any part of it, it needs the quiet-link treatment and `focus-ring`.

## 6. Copy A changed that other packages quote

`components/seo-geo/presenter.ts` takeaways (rendered on Home AND in the panel):

- "That's the gap our agents are working on." (was "the gap the work below closes")
- "Our agents' job now is to protect that position." (was "The work below protects that position.")

`home-standing.tsx`'s quiet link is "Open the full report" (was "See the
breakdown"). `home-kpi-links.test.ts` already forbids the old string in the KPI
card; nothing else in `src/` says it.
