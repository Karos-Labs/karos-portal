# Handoff from package C (Get set up ladder and its landings)

Requests for files C does not own. Each is one edit; nothing in C is blocked on them.

---

## To package A (`components/ui.tsx`)

**Export the Button recipe as a class helper.** `Button` renders a `<button>`, and the ladder's one
accent control NAVIGATES (it opens the field, the document or the run panel that completes the step),
so it has to be a `<Link>` wearing the accent voice — the same device impl-brief §3.E asks for on
Reporting ("`Button variant="outline"` as a Link"). Today that means
`src/components/home-task-row.tsx` restates Button's accent + `size="sm"` class list verbatim
(the `ACCENT_LINK` const, with a comment pointing here), which is exactly the duplicated-recipe
problem think-home §1.3 counts elsewhere.

Requested shape (additive, no behaviour change for existing callers):

```ts
export function buttonClass(opts?: {
  variant?: "primary" | "ghost" | "outline" | "danger" | "subtle" | "accent";
  size?: "sm" | "md" | "lg" | "icon";
  className?: string;
}): string;
```

i.e. lift the `variants` / `sizes` maps and the shared base string out of the component and have
`Button` call it. Then `home-task-row.tsx` becomes
`<Link className={buttonClass({ variant: "accent", size: "sm" })}>` and the recipe lives in one
place again. There are at least three other "a Link styled as a Button" sites in the round-6 work
(Reporting's "Open {agent}", the calendar's empty-state CTA), so the helper pays for itself.

---

## To package E (`app/(app)/clients/[id]/settings/page.tsx`)

**Pass `confirmedDocTypes` to `<ClientDocuments>`.** Decision 3 moved the document step's "done"
from "the client opened it" to "the client pressed Looks right", and the foot of an opened document
now shows either the question or a "Confirmed" line. The component takes an OPTIONAL prop for that:

```tsx
confirmedDocTypes={contextDocConfirmations}   // readonly ContextDocType[]
```

built from the client's action states, which that page can read the same way Home does
(`listClientActionStates(id)` → ids `21` → `brand-voice`, `22` → `target-audience`,
`23` → `competitor-analysis`, keeping any row whose `status` is `"done"` or `"not_relevant"`).

Absent it, the foot simply asks again on a later visit and a second press rewrites the same row
(`upsertClientActionState` is an upsert), so nothing is broken without it — it is a polish item.

`viewerIsClient` on that mount is now unused inside the component (aliased to `_viewerIsClient`,
the `intelSchedule` idiom already in that file). Leave it or drop it, either is fine; dropping it
means editing the mount, so C did not.

---

## To package B (`components/client-agents/task-kickoff-strip.tsx`) and whoever owns `lib/task-kickoff.ts`

**The string "Let's do this" is gone from every rendered surface** (C's acceptance criterion). Three
COMMENT mentions remain, all of them historical narration of Home's old button, none rendered:

- `components/client-agents/task-kickoff-strip.tsx:37`
- `app/(app)/clients/[id]/agents/page.tsx:80` and `agents/[agentId]/page.tsx:209, :1106`
- `lib/task-kickoff.ts:5` (no package owns this file)

If the verifier greps `src/` for the literal, these are what it will find. Suggested rewording:
"Home's setup-ladder control" / "the ladder's one press".

---

## Notes for the verifier (not requests)

- `components/archive-view.tsx`: C owns "the open-on-load change only" and did exactly that
  (`initialAssetId`, `onAssetOpened`). Its `ArchiveTile` still carries `hover:-translate-y-0.5
  hover:border-border-strong hover:shadow-lg`, which is a rule-3 violation nobody's package owns.
  Not fixed here on purpose.
- `components/run-calendar.tsx`: same, C added `initialAssetId` + the `?asset=` cleanup and the
  action-05 write, and touched nothing else.
- `app/(app)/calendar/page.tsx`, `app/(app)/clients/[id]/calendar/page.tsx`,
  `app/(app)/calendar/calendar-body.tsx`: one param threaded through (`asset`), nothing else.
- The document landing is spelled `?tab=profile&doc=<type>&for=voice#documents`, NOT
  `?tab=profile#documents&doc=<type>&for=<stepId>` as impl-brief §3.C writes it: everything after
  the `#` is the fragment, so the brief's spelling would put `doc` and `for` somewhere no
  search-param reader can see them. Same landing, correct URL grammar.
