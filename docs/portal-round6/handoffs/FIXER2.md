# Handoff — FIXER 2 → FIXER 1 (review fix pass 2, 2026-09-04)

One request, and it is **blocking for clients**: without it no client can confirm a document,
so ladder step 2 ("Confirm your brand voice and audience") has no gesture that ticks it.

## `canConfirm` on `<ClientDocuments>` — `src/app/(app)/clients/[id]/settings/page.tsx:~485`

`ClientDocuments` gained `canConfirm?: boolean`, **defaulting to `false`** (review ruling D1: staff
must not confirm a client's document — "Looks right" writes a `ClientActionState` row against the
client's account and ticks their ladder, and "Something is off" opens Support on their behalf). The
default is deliberately the safe one, which means the prop has to be supplied for the client to get
the controls at all.

The page's client-viewer flag is already there, named `isClientViewer`
(`settings/page.tsx:192` — `const isClientViewer = user.role === "CLIENT_USER";`). Add the last line:

```tsx
  const documentsSection = (
    <ClientDocuments
      contextDocs={contextDocs}
      isAdmin={isAdmin}
      clientId={client.id}
      isAiProcessing={isAiProcessingLockActive(client)}
      aiProcessingFailed={hasAiProcessingFailure(client)}
      intelSchedule={clientIntelSchedule(client)}
      allowInternalFallback={isStaff}
      correctionPricing={correctionPricing}
      confirmedDocTypes={confirmedDocTypes}
      canConfirm={isClientViewer}
    />
  );
```

Note this is the same distinction `home-get-set-up.tsx` already draws with `canHide={isClientViewer}`
on the same page's sibling surface, and it is `isClientViewer` rather than `!isStaff` on purpose:
"View as Client" is staff, so it stays read-only.

There is no other mount of `ClientDocuments` in `src/app` (the rail's mount went in the redesign), so
this one line is the whole wiring.

Pinned by `src/lib/__tests__/doc-confirm-gate.test.tsx` on the COMPONENT (render, both directions,
plus the default). Nothing pins the page's mount — if you would rather it were pinned, say so and I
will add it wherever the settings-page mount pins live.
