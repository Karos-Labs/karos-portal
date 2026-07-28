# QA sweep findings — pages 123-160

Extracted from `Karos-portal-QA-sweep-FULL-2026-07-27.pdf`. Covers the tail of the Documents section, the full AI Copilot section (9 findings: #87-95), and the start of the Client dashboard section (7 findings: #97, 125, 99, 124, 126, 145, 100 — of which 100 falls past p160).

---

## F77 · (severity/track on earlier page) · STARTS before p123
**Screenshot:** screenshots/F077.png
**Title:** (title/severity/track are on a page before 123; p123-124 carry the body — regenerate wipes corrections, no version history)
**Where:**
- `src/lib/data.ts:1301-1309` — replaceClientContextDocs deletes all rows for the client, then writes new ones
- `src/lib/intel/pipeline.ts:904` — the pipeline's only write is that wholesale replace
- `src/lib/intel/pipeline.ts:893-901` — every new doc written with version: 1
- `src/lib/actions/intel-actions.ts:432-441` — corrections logged to the feedbacks store via logFeedback
- `src/app/(app)/admin/analytics/page.tsx:56` — listFeedbacks has exactly one caller, and it is not the pipeline
- `src/components/client-documents.tsx:446` — Regenerate modal body text says nothing about replacement
- `src/components/client-documents.tsx:599` — Schedule modal describes the same run as recurring
**What you see:** The Regenerate modal only says you may optionally add run-specific context for this regeneration. Nothing tells you the run deletes and re-creates every document. Corrections a client applied through Correct Info are gone afterwards, and there is nowhere in the product to see a previous version, a comparison, or even how many times a document has changed.
**Why wrong:** The pipeline's final step deletes every context-document row for the client in one batch and writes fresh ones stamped as version 1 — so the content, the version counter and every hand-applied correction are wiped together. Corrections are written to a separate feedback store, but nothing in the intel pipeline ever reads that store back (its only reader is the admin analytics page), so the next run has no memory of them and confidently restores the wrong facts. The Schedule modal makes this recurring and unattended, so a client's corrections evaporate on a cadence nobody warned them about.
**Fix per doc:** Two parts. (1) In the RegenerateModal body in src/components/client-documents.tsx (around line 446), add a plain sentence: "This replaces all documents. Corrections applied since the last run will be lost." (2) In runOnboardPipeline (src/lib/intel/pipeline.ts:726), load this client's feedback rows — add a data.ts reader alongside listFeedbacks that filters by clientId and scope single_doc/global — and append them to the per-document generation prompt as verified client ground truth, using the same ABSOLUTE GROUND TRUTH framing applyDocCorrections already applies to correction text. If a fuller fix is wanted, keep the prior row instead of deleting it in replaceClientContextDocs (src/lib/data.ts:1301) so a previous version survives.
**Systems touched:** intel pipeline, documents/regenerate modal, corrections/feedback store, versioning

---

## F78 · HIGH · Track B
**Screenshot:** screenshots/F078.png
**Title:** Regenerate runs the whole multi-minute pipeline inside one request, so it can report failure on a run that is still going — and it traps you in the modal while it waits
**Where:**
- `src/lib/actions/intel-actions.ts:183` — await runIntelReportPipeline(...) inline in the action
- `src/lib/actions/intel-actions.ts:176` — lock acquired in the same request
- `src/components/client-documents.tsx:403` — setRunning(true) then await in handleConfirm
- `src/components/client-documents.tsx:396` — Escape ignored while running
- `src/components/client-documents.tsx:422` — backdrop click ignored while running
- `src/components/client-documents.tsx:477` — Cancel disabled while running
- `src/components/client-documents.tsx:491` — "Running pipeline…" is the only progress UI
- `cloudbuild.yaml:126` — --timeout=300
- +4 further references in the verification record
**Location in app:** Documents nav group → Regenerate → "Regenerate Intel Report" modal (staff sidebar, on every /clients/[id]/* page)
**What you see:** You click Regenerate, optionally type run context, hit Confirm and Run. The button turns into "Running pipeline…" with a spinning icon and stays there. Cancel is greyed out, the Escape key does nothing, clicking the dark backdrop does nothing. There is no progress, no step list, no estimated time. Minutes later, if the connection has been cut, you get a red error box — with no way to tell whether the regeneration happened, is still happening, or never started. Trying again then tells you generation is already running for this client.
**Why wrong:** The server action awaits the entire Intel Report + SEO/GEO pipeline inside the HTTP request. Cloud Run is deployed with a 300-second request timeout, while the codebase's own comment describes this pipeline as normally finishing "in a few minutes" and allows 20 minutes before treating a run as dead. Any run past five minutes has its request killed: the modal reports a failure for a run that may have completed, may still be mid-flight, or may have been frozen mid-pipeline — and the 20-minute stale-lock window blocks retries. All three other triggers of this exact pipeline (client creation, onboarding completion, the cron) deliberately run it in the background via after() or a maxDuration=300 route; the Regenerate button is the only caller that makes a human sit on the connection.
**Fix per doc:** In src/lib/actions/intel-actions.ts, restructure generateIntelReportAction to match the pattern already in src/lib/actions/onboarding-actions.ts:101-120: keep the tryAcquireAiProcessingLock check and its thrown "already running" error synchronous, then move the runIntelReportPipeline / updateClient / logActivity / releaseAiProcessingLock block inside after() and return immediately. In src/components/client-documents.tsx RegenerateModal, call onSuccess() as soon as the action resolves (it already closes the modal and calls router.refresh()), and let the existing AiProcessingBanner plus the isAiProcessing lock — which already disables the Regenerate button at line 749 — be the progress UI.
**Systems touched:** intel pipeline, server actions, AI processing lock, Cloud Run deployment, regenerate modal UX

---

## F79 · MEDIUM · Track A
**Title:** A document that generated empty still shows in the nav and opens to a completely blank panel
**Where:**
- `src/lib/intel/condense.ts:43-45` — returns { docType, content: "" } when the source is empty
- `src/lib/intel/pipeline.ts:893-901` — condensed docs written with no content check
- `src/lib/intel/pipeline.ts:448` — generateDoc has no minimum-length guard on its return
- `src/lib/intel/report.ts:289-292` — the codebase's own note that a failed stream resolves with partial text and does not reject
- `src/components/client-documents.tsx:727-729` — the nav filter checks only that the doc object exists
- `src/components/client-documents.tsx:341` — renderFullDoc("") returns "" and there is no fallback
**Location in app:** Documents nav group → any document row whose content came back empty. (No screenshot: absence-of-something finding.)
**What you see:** You click Competitor Analysis. The panel slides in with the title, the Export button and Correct Info — and an entirely empty body. No message, no spinner, no explanation. Exporting it prints a page with just a heading. You cannot tell whether this document failed to generate or the app is broken.
**Why wrong:** The condensation step returns an empty client-facing document when its source is empty, and the pipeline stores that empty document unconditionally alongside the others. The document generator itself has no non-empty guard, and by the codebase's own account a failed model stream resolves with whatever partial text arrived — which can be nothing. The nav filter only checks that a document object exists, never that it has content, so an empty row renders and opens, the full-document renderer returns nothing for empty input, and the viewer has no empty-state branch.
**Fix per doc:** Three small edits. In src/components/client-documents.tsx:727, filter on content: `.filter((i) => i.doc && stripDocPreamble(i.doc.content).length > 40)` (stripDocPreamble is already imported from src/lib/doc-render.ts). In DocOverlay (src/components/client-documents.tsx:338), when renderFullDoc returns an empty string render a plain line: "This document has not been generated yet — ask your Karos team to regenerate it." In src/lib/intel/pipeline.ts:893, skip condensed entries whose content is blank so the empty row never gets written at all.
**Systems touched:** intel pipeline, condense step, documents nav, doc viewer

---

## F80 · MEDIUM · Track A
**Screenshot:** screenshots/F080.png
**Title:** Brand and strategy documents open as one flat wall with no section navigation, and the helper that would hide the empty placeholder sections is dead code
**Where:**
- `src/components/client-documents.tsx:338-343`
- `src/lib/doc-render.ts:29-45`
- `src/lib/doc-render.ts:126-147`
- `src/components/client-documents.tsx:23-31`
- `src/components/client-rail.tsx:138`
- `src/components/sidebar.tsx:385`
**Location in app:** Side rail → Documents → any document (Brand Voice, Market Strategy, Competitor Analysis…)
**What you see:** A half-screen drawer slides in with the whole generated document rendered end to end — orange section headings, paragraphs, tables, bullets — in one scroll, with no contents list, no section index, no way to jump or fold. Sections whose body is nothing but "Unknown", "Not provided" or "TBD" are rendered in full, so the client reads placeholder text as if it were a finding.
**Why wrong:** The drawer calls the whole-document renderer, which walks the section headings only to colour them and then concatenates everything. A section splitter that returns heading-and-body pairs, and explicitly drops sections whose body is nothing but placeholder words, sits in the same file with no callers anywhere in the app. Both the structure needed for a readable index and the placeholder suppression the client deserves are already written and unused. These seven documents are the richest thing the platform produces and they have no page of their own — they are reachable only from a list item in the rail.
**Fix per doc:** In src/components/client-documents.tsx:338-343 replace `renderFullDoc(doc.content)` with `parseDocSections(doc.content)` (already exported from src/lib/doc-render.ts:29) and render a two-pane drawer: a sticky left column listing the section headings as anchor buttons, bodies on the right via the already-exported `renderSectionBody(section.body)` inside `<section id=...>`. Keep the first section open and wrap the rest in the existing src/components/seo-geo/disclosure.tsx. Update the import at line 8 to pull parseDocSections and renderSectionBody instead of renderFullDoc. Placeholder suppression comes free with the swap (doc-render.ts:40-41).
**Systems touched:** doc viewer, doc-render library, dead code

---

## F81 · MEDIUM · Track B
**Screenshot:** screenshots/F081.png
**Title:** Correcting a document does not reach the AI that quotes it — the Copilot and the X agent keep answering from the uncorrected copy
**Where:**
- `src/lib/actions/intel-actions.ts:418` — updateContextDocContent on the single opened document only
- `src/lib/copilot-context.ts:52-54` — prompt built from both internal and client tiers
- `src/lib/copilot-context.ts:62-65` — dedupe keeps the first row seen per docType
- `src/lib/data.ts:1250-1261` — getClientContextDoc: no tier filter, bare .limit(1) on an unordered query
- `src/lib/actions/x-agent-actions.ts:249-250` — the X agent uses that helper
- `src/lib/actions/intel-actions.ts:474-481` — the existing internal→client propagation block
- `src/lib/actions/intel-actions.ts:456` — applyDocCorrectionAction, which has no caller anywhere in src/components
**Location in app:** Document viewer → Correct Info, versus the Copilot dock and the X agent's account suggestions
**What you see:** A client corrects their pricing in Product Information, sees the corrected document, then asks the Copilot about pricing and gets the old number back. Same for the X agent's suggest-accounts step, which reads Target Audience and Market Strategy.
**Why wrong:** A correction edits exactly one stored document — the one the viewer opened, which the picker resolves to the client-facing copy. Its internal twin is untouched. The Copilot then builds its prompt from both tiers and keeps only the first copy it encounters per document type, which is whichever one the database happens to return first — so the uncorrected internal copy frequently wins, and even when it does not, the Copilot is quoting internal text at a client. The X agent looks documents up with a helper that has no tier filter and takes the first row of an unordered query, so it draws an arbitrary tier. There is already a staff action that propagates a correction from the internal copy to the client copy, and no screen in the product calls it.
**Fix per doc:** In applyTargetedDocCorrection (src/lib/actions/intel-actions.ts, after the write at line 418), apply the same corrections to the sibling tier for that docType — the propagation block at lines 474-481 of applyDocCorrectionAction is the exact code to lift, using getClientContextDocByTier + applyDocCorrections + updateContextDocContent. Separately, make the tier argument required on getClientContextDoc (src/lib/data.ts:1250) so its seven callers — src/lib/actions/x-agent-actions.ts:249-250, src/lib/branding.ts:752-753, src/lib/actions/branding-actions.ts:37-38, src/lib/transcripts/ingest.ts:195, src/app/api/clients/[id]/chat/route.ts:230 — must name the tier they want instead of drawing an arbitrary one.
**Systems touched:** corrections, copilot context, X agent, data layer (context doc tiers)

---

## F82 · MEDIUM · Track B
**Title:** Exported PDFs silently swallow any text in angle brackets, including the templates' unfilled placeholder slots
**Where:**
- `src/components/client-documents.tsx:66-77` — renderForPrint starts from raw markdown, no esc()
- `src/components/client-documents.tsx:127` — only the <title> is escaped
- `src/components/client-documents.tsx:168` — only the <h1> heading is escaped
- `src/components/client-documents.tsx:124` — renderForPrint(clean) fed straight into the document body
- `src/lib/doc-render.ts:49-51` — the on-screen renderer escapes first, with the reason in a comment
- `src/lib/intel/templates.ts:36` — "- Formal ↔ casual: <position + when it moves>"
- `src/lib/intel/templates.ts` — 110 angle-bracket placeholder slots across the templates
**Location in app:** Document viewer slide-over → Export → Export PDF (print window). (No screenshot: absence finding.)
**What you see:** A client exports Brand Voice as a PDF. On screen a voice-dimension bullet reads "Formal to casual: position plus when it moves" inside angle brackets. In the printed PDF the same bullet reads "Formal to casual:" and then nothing — the bracketed text has vanished. Any line with angle-bracketed text loses that text in the export, so a partly-filled document silently loses content in exactly the file a client is most likely to forward.
**Why wrong:** The print renderer builds its HTML without ever escaping the document body — only the page title is escaped. The on-screen renderer escapes first and says why in a comment: so any angle brackets in the source text cannot break out into the surrounding structure. The print path runs the same model-written markdown with that protection removed, so the browser parses angle-bracketed text as markup and drops it. The document templates are full of angle-bracket placeholder slots, so any section the model left unfilled loses its text. A stray image or script tag reaching a document would also execute in the print window.
**Fix per doc:** In renderForPrint (src/components/client-documents.tsx:66), open with the same escape the on-screen renderer uses: `let out = esc(markdown).replace(/^---+$/gm, "")` — esc is already defined at line 58 and mirrors doc-render.ts's helper. Every tag renderForPrint emits is generated after that point, so no other change is needed.
**Systems touched:** PDF export / print renderer, XSS safety, intel templates

---

## F83 · MEDIUM · Track A
**Screenshot:** screenshots/F083.png
**Title:** Raw markdown leaks into the document viewer: literal hash marks, orphaned nested bullets, and unrendered link syntax
**Where:**
- `src/lib/doc-render.ts:53-56` — heading rule matches only ^###\s+ (and ^##\s+ in renderFullDoc:128)
- `src/lib/doc-render.ts:93` — bullet rule ^[-*+]\s+, no leading whitespace allowed
- `src/lib/doc-render.ts:117-120` — anything unmatched becomes a plain paragraph
- `src/lib/doc-render.ts` — no link rule anywhere in the file
- `src/lib/intel/templates.ts:133` — "#### <Persona name>" inside the Market Strategy template (lines 107-184)
- `src/components/client-documents.tsx:341` — renderFullDoc output injected into the viewer
**Location in app:** Document viewer slide-over — most visibly Market Strategy → Personas
**What you see:** Inside a client-facing document you read a line that literally begins with four hash marks before the persona's name, sub-bullets that show a bare dash and sit outside the styled bullet list at the wrong indentation, and any source reference printed as square-bracket text followed by a raw address in parentheses instead of a link.
**Why wrong:** The renderer handles only two levels of heading, only bullets that start at the very beginning of a line, and has no link rule at all. A four-hash heading fails the three-hash test (the next character is a hash, not a space) and falls through to the plain-paragraph rule, so the hashes render as visible text. Indented sub-bullets fail the bullet test and become paragraphs starting with a dash. Link syntax passes through verbatim. The four-hash persona heading is not hypothetical — it is in the shipped template that generates the Market Strategy document. This is raw model formatting reaching a client inside the client's own strategy documents.
**Fix per doc:** In renderSectionBody (src/lib/doc-render.ts:48): add a rule for ^####\s+(.+)$ ABOVE the ### rule at line 53, rendered as a small bold label; relax the bullet and ordered-list rules at lines 93 and 103 to ^[ \t]*[-*+]\s+ / ^[ \t]*\d+\.\s+ and emit an indent class for matches with leading whitespace; add a link pass \[([^\]]+)\]\(([^)]+)\) → anchor with target="_blank" rel="noopener" (safe because the input is already escaped at line 51). Mirror the same three rules in renderForPrint (src/components/client-documents.tsx:66) so the PDF matches the screen.
**Systems touched:** doc-render library, doc viewer, PDF export, intel templates

---

## F84 · MEDIUM · Track B
**Screenshot:** screenshots/F084.png
**Title:** The Schedule modal shows the wrong "Next run" date for any cadence longer than monthly
**Where:**
- `src/components/client-documents.tsx:568` — previewNextRun = computeFirstIntelScheduleRun(dayOfMonth)
- `src/components/client-documents.tsx:662-666` — that preview rendered as "Next run"
- `src/components/client-documents.tsx:670` — schedule.lastIntelReportAt is the only field of the prop that is read
- `src/lib/intel-schedule.ts:42` — computeFirstIntelScheduleRun = next occurrence of the day
- `src/lib/intel-schedule.ts:61` — computeNextIntelScheduleRun = previous slot + intervalMonths
- `src/app/api/intel-report-schedule/route.ts:79` — the cron advances with computeNextIntelScheduleRun
- `src/lib/intel-schedule.ts:16` — nextRunAt is already on the IntelScheduleInfo prop
**Location in app:** Documents nav group → Schedule → "Regeneration Schedule" modal (admin)
**What you see:** An admin has "Every 3 months, on the 1st" saved and the real next run is 1 October. Open the Schedule modal to check it and Next run reads 1 August. Close without saving and the date you were shown was simply false. Hit Save to "confirm" what you saw and you have just pulled the whole cadence two months earlier.
**Why wrong:** The modal computes its preview as the next calendar occurrence of the chosen day-of-month and never reads the saved next-run date it was already handed in its props (it only reads the last-generated date from that same object). The cron advances the real date by adding the interval to the slot that just fired, so the two agree only when the interval is one month. The modal is the only place a schedule can be inspected, so the one number an admin opens it to check is the one that is wrong.
**Fix per doc:** In ScheduleModal (src/components/client-documents.tsx around line 568), derive a dirty flag by comparing enabled/intervalMonths/dayOfMonth against the incoming `schedule` prop, then render formatDate(schedule.nextRunAt) labelled "Next run" while clean, and formatDate(computeFirstIntelScheduleRun(dayOfMonth)) labelled "Next run after saving" while dirty. No change to updateIntelScheduleAction, whose re-anchoring is deliberate and documented.
**Systems touched:** intel schedule, schedule modal, cron

---

## F85 · MEDIUM · Track A
**Screenshot:** screenshots/F085.png
**Title:** The client is billed 2 credits for a correction with no price shown anywhere in the flow
**Where:**
- `src/lib/credits.ts:47` — targetedCorrection: 2
- `src/lib/actions/intel-actions.ts:404-409` — charged before the model call
- `src/components/correct-info-modal.tsx:113-116` — the hint paragraph, no price
- `src/components/custom-agents.tsx:1253` — "Costs {agentRunCost(agent)} credits." for client viewers
- `src/components/custom-agents.tsx:335` — "{agentRunCost(agent)} credits per client run"
**Location in app:** Document viewer → Correct Info modal (client user)
**What you see:** The modal explains what a correction does and how to phrase it, then you hit Apply Correction. Nothing mentions credits. The credits figure in the rail quietly drops by 2. If your balance or weekly cap is short, the only signal is a red error after you have already committed.
**Why wrong:** A targeted correction costs 2 credits and is charged to any billable client user before the model runs. Every other client-billable action in the product discloses its price up front — the agent run dialog prints "Costs N credits." for client viewers, and the agent cards show "N credits per client run". This surface is the one that stays silent, which reads as a hidden charge.
**Fix per doc:** Thread the viewer role and balance down to the modal: src/components/client-rail.tsx already has both (isStaff at line 64, creditBalance at line 49), so pass a viewerIsClient flag and creditBalance into ClientDocuments → DocOverlay → CorrectInfoModal. In src/components/correct-info-modal.tsx, render "Costs 2 credits." next to the Cmd-Enter hint at lines 113-116 using CREDIT_COSTS.targetedCorrection from src/lib/credits.ts (client-safe), matching the wording at src/components/custom-agents.tsx:1253, and disable Apply Correction with an inline shortfall message when the balance is below the cost.
**Systems touched:** credits, correct-info modal, client rail

---

## F138 · MEDIUM · Track B
**Screenshot:** screenshots/F138.png
**Title:** Document body numbering starts at "2." and the numbers are baked into the text
**Where:**
- `src/lib/intel/pipeline.ts` — document generation writes the numbered headings as literal text
- `src/components/client-documents.tsx` / `doc-render.ts` — the viewer renders headings as authored
**Location in app:** Documents → Brand Voice (and the other generated documents)
**What you see:** The first numbered heading in Brand Voice is "2. Five voice adjectives", followed by "3. Voice dimensions". There is no section 1.
**Why wrong:** Section 1 was consumed by the auto-synced block at the top, but the numbers are literal characters in the generated markdown, so the document reads as if a section is missing. Nothing can renumber it because the numbers are content, not structure.
**Fix per doc:** Drop the literal numbers from the generation prompt and let the viewer number sections from the heading structure, so the auto-synced block cannot shift the sequence.
**Systems touched:** intel pipeline generation prompts, doc viewer/doc-render

---

## F86 · LOW · Track B
**Screenshot:** screenshots/F086.png
**Title:** No document tells you how old it is — no last-updated, no version, and no way to navigate a fourteen-section document
**Where:**
- `src/lib/types.ts:796` — version on ClientContextDoc (createdAt/updatedAt at 802-803)
- `src/components/client-documents.tsx:316-317` — viewer header shows only the label
- `src/components/client-documents.tsx:770-781` — nav rows show only the label
- `src/lib/actions/intel-actions.ts:294` — generateDocSummaryAction, with no caller anywhere in src/
- `src/lib/doc-render.ts:29` — parseDocSections already extracts the section headings
- `src/lib/intel/templates.ts:21-106` — the Brand Voice template has fourteen top-level sections
**Location in app:** Documents nav rows and the document viewer slide-over header
**What you see:** Brand Voice opens as one continuous scroll of fourteen numbered sections in a half-width panel. The header has a title, Export, Correct Info and a close cross. Nothing says when the document was generated, whether it has been corrected since, or which version you are reading. To reach the social-voice section you scroll blind.
**Why wrong:** Each document already carries a version number and created/updated timestamps, and the Schedule modal explicitly promises recurring regeneration — so "is this current?" is the first question a user has, and the viewer answers none of it. There is no section index and no collapsing, so the useful part of a long analyst document sits well below the fold. A per-document executive summary already exists on the server, with caching and usage logging, and no screen ever calls it — the built answer to this is sitting unused.
**Fix per doc:** In DocOverlay's header (src/components/client-documents.tsx:316-317), add a subline: "Updated {formatDate(doc.updatedAt)} · v{doc.version}" — formatDate already exists at line 502 and both fields are on the doc object. Add a sticky section index down the left of the panel built from parseDocSections(doc.content) (src/lib/doc-render.ts:29), anchoring to the h2 ids renderFullDoc emits at doc-render.ts:138 (give them ids). If the summary is wanted, call generateDocSummaryAction(clientId, docType, tier) on open and render its bullets above the body; it already serves a cached result when the version is unchanged.
**Systems touched:** doc viewer, doc-render, dead code (generateDocSummaryAction)

---

## F139 · LOW · Track A
**Screenshot:** screenshots/F139.png
**Title:** A teammate's real name is used as the example of a wrong fact in client-facing copy
**Where:** `src/components/correct-info-modal.tsx` — the textarea placeholder
**Location in app:** Documents → any document → Correct Info
**What you see:** The placeholder reads: e.g. "Our pricing is $49/mo, not $99/mo" or "The founder's name is Tomer, not John".
**Why wrong:** It hardcodes a real Karos teammate into an example a client reads, and implies he is the founder of whichever company is looking at it.
**Fix per doc:** Use a neutral example: "Our head office is in Tel Aviv, not London".
**Systems touched:** correct-info modal copy

---

## F140 · LOW · Track A
**Screenshot:** screenshots/F140.png
**Title:** A fill-in-the-blank label ships as "EVERY ___ MONTH(S)"
**Where:** `src/components/client-documents.tsx` — the Regeneration Schedule modal labels
**Location in app:** Documents → Schedule → Regeneration Schedule
**What you see:** The field label is literally "EVERY ___ MONTH(S)" with three underscores, above a number input.
**Why wrong:** The underscores are a placeholder for the value that sits in the input beside it, so the label reads as unfinished.
**Fix per doc:** "Repeat every" with the unit beside the input: "Repeat every [3] months".
**Systems touched:** schedule modal copy

---

# AI Copilot section (section intro, p142)

"A metered feature — 1 credit per message for a client account. Its entire action surface is a zero-state that disappears after the first message." 9 findings: #87, 88, 89, 90, 91, 92, 93, 94, 95.

---

## F87 · HIGH · Track B
**Title:** "Competitor Deep-Dive" asks for a competitor's web address it has no way to open
**Where:**
- `src/components/chatbot-widget.tsx:44-47` — sublabel "Generate intel brief + counter-strategy tasks" and a trigger that promises "I'll give you their URL"
- `src/app/api/clients/[id]/chat/route.ts:637-642` — tools: update_branding_guidelines, send_support_email, fetch_gmail_context, create_tasks
- `src/lib/ai/prompts/proactive-assistant.ts:381-384` — live Action 2 instruction: request the URL, deliver the 3-section brief, create 3-5 tasks; no data-source requirement
- `src/lib/copilot-context.ts:36` — "Never hallucinate data — only reference what is listed below" (in tension with the above)
- `src/lib/copilot-context.ts:106-120` — the only competitor data the model has is the stored tracker rows
- `src/lib/ai/prompts/proactive-assistant.ts:483,512,548` — buildCompetitorResearchPrompt / buildBrandAuditPrompt / buildContentDispatchPrompt, zero callers in src
- `src/lib/intel/report.ts:280-281` — the working web-search + web-fetch pattern in this repo
**Location in app:** AI Copilot panel → "Competitor Deep-Dive — Generate intel brief + counter-strategy tasks". (No screenshot: absence finding.)
**What you see:** Click it and the copilot asks which competitor to focus on. Paste a company name or a web address and, ten to twenty seconds later, you get a confident three-part brief — positioning, key strengths, counter-strategy — plus three to five new task cards.
**Why wrong:** The chat endpoint gives the model exactly four abilities: update branding, email support, read Gmail, create tasks. There is no web search and no page fetch, so the brief can only come from the competitor rows already stored in the account or from the model's own recollection of the brand. A confident competitor brief produced in reply to a web address the platform never opened is the most credibility-expensive thing in this panel. Supporting signal that this action was never finished: its purpose-built prompt, and the ones for the brand audit and content dispatch, have no callers anywhere in the codebase — the buttons just fire a sentence into the generic chat and rely on keyword matching to shape the reply.
**Fix per doc:** Either wire it up or stop asking for a URL. To wire it: in src/app/api/clients/[id]/chat/route.ts add `web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 })` and `web_fetch: anthropic.tools.webFetch_20250910({ maxUses: 4, maxContentTokens: 6000 })` to the tools object at line 637 (same shape as src/lib/intel/report.ts:280-281 — note stopWhen is stepCountIs(6) at line 45, raise it), and amend Action 2 in src/lib/ai/prompts/proactive-assistant.ts:381-384 to require at least one search before writing the brief. If web access is deliberately out of scope, change the sublabel and trigger in src/components/chatbot-widget.tsx:44-47 to stop asking for a URL and say the brief is built from the tracked competitor list, and delete the three uncalled builders at proactive-assistant.ts:483, 512 and 548 so the next developer does not assume this is wired.
**Systems touched:** AI copilot, chat route tools, web search/fetch, dead code (prompt builders)

---

## F88 · HIGH · Track A
**Screenshot:** screenshots/F088.png
**Title:** All four AI actions disappear after the first message, and the only way back destroys the thread
**Where:**
- `src/components/chatbot-widget.tsx:454` — showProactiveWelcome = defaultOpen && messages.length === 0
- `src/components/chatbot-widget.tsx:557-571` — messages.length === 0 is the only gate on the welcome block
- `src/components/chatbot-widget.tsx:524-533` — the reset control is labelled "Clear conversation" and only appears once messages exist
- `src/components/chatbot-widget.tsx:79` — messages held in useState, no storage
- `src/components/chatbot-widget.tsx:85-91` — reset() empties messages entirely
- `src/components/copilot-dock.tsx:25-26` — collapsed and sheetOpen are plain useState
- `src/app/api/clients/[id]/chat/route.ts:88-96` — every message charges CREDIT_COSTS.chatMessage for a billable client
- `src/components/chatbot-widget.tsx:324` — <p className="text-[11px] text-muted truncate">
- +6 further references in the verification record
**Location in app:** AI Copilot panel (right rail) — welcome state versus message state
**What you see:** The greeting, the "Describe a task you need done..." box, the four AI actions and the three suggested questions only exist while the transcript is empty. Ask one question, or click one action, and all of those controls vanish for the rest of the session. The only way back is the small circular-arrow button in the header, whose tooltip says "Clear conversation" — it wipes the whole thread. A browser reload also erases the conversation and re-opens the rail.
**Why wrong:** An empty transcript is the sole condition for showing the welcome block, so the panel's entire action surface is a zero-state. A client who wants a Brand Visibility Audit after asking one question has to destroy the answer they just paid a credit for. Nothing is stored either: the transcript, the rail's collapsed state and the mobile sheet's open state are all in-memory component state, so a reload silently discards a paid conversation.
**Fix per doc:** In src/components/chatbot-widget.tsx lift the four action cards and the quick-add form out of the messages.length === 0 branch (lines 557-571): render ProactiveWelcome's action list as a strip directly above the input form (line 608), collapsed behind a small "AI actions" toggle once messages.length > 0. Separately persist the transcript — sessionStorage keyed by clientId is enough for v1 — and persist `collapsed`/`sheetOpen` from src/components/copilot-dock.tsx:25-26 in localStorage so a reload does not re-expand the rail. Note the dock lives in the (app) layout (src/app/(app)/layout.tsx:113) so in-app navigation already preserves state; only a hard reload loses it.
**Also reported as:** The four action subtitles are clamped to one line and the longest ones clip mid-phrase.
**Systems touched:** AI copilot widget, copilot dock, credits (paid conversation loss), state persistence

---

## F89 · HIGH · Track A
**Title:** Raw model markup is shown to the client — asterisks, hashes and table pipes land in the panel
**Where:**
- `src/components/chatbot-widget.tsx:587-591` — <span style={{whiteSpace:"pre-wrap"}}>{msg.content}</span>, no formatter
- `src/lib/copilot-context.ts:34` — prompt opens with **${client.name}**
- `src/lib/copilot-context.ts:68` — ### headings per context doc
- `src/lib/copilot-context.ts:99` — numbered **bold** recommendations
- `src/lib/ai/prompts/proactive-assistant.ts:383` — "Deliver a concise 3-section intel brief"
- `src/lib/ai/prompts/proactive-assistant.ts:388` — "Produce a 5-section structured audit"
- `src/lib/doc-render.ts:48-123` — renderSectionBody: escapes first, then formats bold/italics/code/lists/tables/blockquotes
- `src/components/client-documents.tsx:341` — existing consumer via dangerouslySetInnerHTML
**Location in app:** AI Copilot panel → assistant replies (all actions and any typed question). (No screenshot: absence finding.)
**What you see:** Answers arrive as one unformatted block with the markup visible as characters: double asterisks around headings, hash marks before section titles, and pipe characters where a table was intended. The worst cases are exactly the flagship actions, because those are the ones instructed to return a three-section brief or a five-section audit.
**Why wrong:** The assistant bubble prints the model's text straight into a pre-wrapped span with no formatter. At the same time nothing tells the model to write plain text — the opposite: the system prompt is itself authored in markdown and the action instructions ask for structured multi-section deliverables, so the model mirrors that style. This is the standing house rule (never show raw model copy to a client) broken on the most-used AI surface in the portal, and a suitable in-house renderer already exists and is already used by the documents view.
**Fix per doc:** Two-sided. (1) In src/components/chatbot-widget.tsx:587-591 render assistant messages (role === "assistant" only) with `<div dangerouslySetInnerHTML={{ __html: renderSectionBody(msg.content) }} />` importing renderSectionBody from @/lib/doc-render — it escapes before formatting, so model output cannot inject markup, and it is already used this way at src/components/client-documents.tsx:341. Keep the plain span for user messages. (2) Add an output-style block to buildCopilotSystemPrompt in src/lib/copilot-context.ts (alongside the instructions at lines 34-37) pinning what the renderer supports: short bold labels and hyphen bullets, no ## headings, no tables, sentence case — so the model's shape and the renderer agree.
**Systems touched:** AI copilot widget, copilot system prompt, doc-render

---

## F90 · HIGH · Track B
**Title:** The War Room reports "Consensus reached" when it created nothing, then closes before the reason can be read
**Where:**
- `src/components/strategy-war-room.tsx:195-199` — done state is unconditionally success-styled (border-success/bg-success) with "Consensus reached"
- `src/components/strategy-war-room.tsx:138-144` — setTimeout(onClose, 1600) fires on any done event
- `src/components/strategy-war-room.tsx:65-68` — the persisted note is appended as a console line only
- `src/lib/agent-swarm.ts:414-426` — duplicatesSkipped / capSkipped drop candidates
- `src/lib/agent-swarm.ts:477-486` — the note string, e.g. "Locked 0 tasks (5 duplicates skipped; 3 deferred — queue at capacity)."
- `src/lib/agent-swarm.ts:358` — done carries persisted.created, which can be 0
- `src/lib/constants.ts:52` — MAX_ACTIVE_TASKS = 15
**Location in app:** AI Copilot panel → Refresh Task Map → Strategy War Room modal. (No screenshot: absence finding.)
**What you see:** After a minute or so of agents debating, the window shows a green tick and "Consensus reached - 0 tasks locked into your map.", waits about a second and a half, then closes itself. The board is unchanged and the client has no idea why.
**Why wrong:** Zero is a routine outcome: every swarm task is Karos-managed, and the save step drops any candidate that duplicates something already on the board or that exceeds the fifteen-active-task ceiling. The only explanation the client ever gets is one grey console line inside a box that self-destructs — so a success-styled green banner is the last thing they see after a long wait in which nothing happened.
**Fix per doc:** In src/components/strategy-war-room.tsx branch the footer at lines 195-200 on `created`: when created === 0 render a neutral or amber panel that repeats the persisted note (already carried on the persisted event as duplicatesSkipped / capSkipped / note, handled at line 65-68 — store it in state alongside setCreated) plus the concrete next step ("your board is already at 15 active tasks — approve or complete some, then run this again"), and skip the auto-close by gating the setTimeout at line 142 on created > 0. Keep the green banner and the auto-close only for created > 0.
**Systems touched:** strategy war room, agent swarm, task board

---

## F91 · MEDIUM · Track B
**Title:** "AI Content Dispatch" says it queues content runs; nothing is queued
**Where:**
- `src/components/chatbot-widget.tsx:62-65` — label and sublabel "Propose & queue managed content runs for this week"
- `src/lib/ai/prompts/proactive-assistant.ts:391-394` — Action 4: propose a calendar, then create_tasks after confirmation
- `src/app/api/clients/[id]/chat/route.ts:587-600` — createClientTask with status "pending" and metadata.completionTrigger
- `src/app/api/clients/[id]/chat/route.ts:610` — returns "Created N tasks in your task board"
- `src/lib/actions/task-actions.ts:61-69,85-88` — moving a karos_managed task to in_progress is what triggers the mapped agent
- `src/lib/actions/settings-actions.ts:41-47` — autopilot only executes a batch at the moment it is switched on, so it does not pick these up later
**Location in app:** AI Copilot panel → "AI Content Dispatch — Propose & queue managed content runs for this week". (No screenshot: absence finding.)
**What you see:** Click it and you get a proposed seven-day calendar with an agent named per slot. Confirm, and a handful of cards appear on the board in the pending column. No agent starts, nothing shows as running, and no run appears anywhere.
**Why wrong:** "Queue managed content runs" states that work has been dispatched. The only write on this path creates pending cards that carry the intended product in their metadata. A run starts only when a human later drags the card into In Progress — that transition is what fires the mapped agent. So the button proposes and files paperwork; the word "queue" claims an execution step it never performs.
**Fix per doc:** Cheapest correct fix: change the sublabel in src/components/chatbot-widget.tsx:63 to "Propose this week's content plan as ready-to-run tasks" (and drop "queue" from the trigger at line 64-65). To make "queue" true instead, follow the create_tasks result with an explicit "Start these now" confirmation in the panel that calls startTaskExecutionAction (src/lib/actions/execution-actions.ts:72) per created task — and show the cost first, since a product run is priced at 10-20 credits (src/lib/credits.ts:132-141) against 1 for a chat message.
**Systems touched:** AI copilot, task board, execution actions, credits

---

## F92 · MEDIUM · Track B
**Title:** A War Room run can create an extra campaign the console never mentions, the count excludes, and the task ceiling does not bound
**Where:**
- `src/components/strategy-war-room.tsx:17-22` — the Line union has no campaign kind
- `src/components/strategy-war-room.tsx:52-78` — handleEvent switch: round_start, agent_message, consensus, persisted, done, error — no campaign case
- `src/lib/agent-swarm.ts:174` — the campaign event exists on SwarmEvent
- `src/lib/agent-swarm.ts:329-343` — the campaign branch yields it
- `src/lib/agent-swarm.ts:358` — done carries persisted.created only
- `src/lib/campaign-engine.ts:228-243` — createClientTask called per draft with no getTaskBoardCapacity and no findDuplicateReason
- `src/lib/agent-swarm.ts:407-426` — the checks persistSwarmTasks does run, for contrast
- `src/lib/constants.ts:52` — MAX_ACTIVE_TASKS = 15
- +1 further reference in the verification record
**Location in app:** AI Copilot panel → Refresh Task Map → Strategy War Room modal, on a client with a strong past performer. (No screenshot: absence finding.)
**What you see:** On a client whose best-performing asset scores 80 or above, the run also builds a full multi-channel campaign — a campaign record plus its own blog, newsletter and social tasks. The console shows nothing about it, and the closing banner reports only the debate's own count, so it might say seven tasks were locked when eleven cards were actually created. The board then shows work the client was never told about.
**Why wrong:** The engine emits a campaign notice, but the console's event handler has no case for it, so the frame is parsed and silently dropped. The closing count is the debate's saved total only and excludes the campaign's tasks. More seriously, the campaign builder writes its tasks directly with no capacity check and no duplicate check, so the fifteen-active-task ceiling — which the copilot prompt tells clients is enforced server-side and impossible to exceed — is bypassed on this path, and a board already at the limit quietly goes over.
**Fix per doc:** In src/components/strategy-war-room.tsx add a `campaign` kind to the Line union (line 17-22), a case in handleEvent (line 52-78) and a branch in ConsoleLine (line 217-249) printing the campaign title and its task count, and include the campaign's tasks in the closing total — simplest is to add campaign.taskIds.length to the created value yielded at src/lib/agent-swarm.ts:358. Separately, route generateCampaignBundle's drafts through getTaskBoardCapacity and findDuplicateReason before the createClientTask loop at src/lib/campaign-engine.ts:215-247, mirroring persistSwarmTasks (src/lib/agent-swarm.ts:407-442), so the documented ceiling actually holds.
**Systems touched:** strategy war room, agent swarm, campaign engine, task board capacity

---

## F93 · MEDIUM · Track A
**Title:** Escape or a stray click outside throws away a minute-long War Room run with no warning
**Where:**
- `src/components/strategy-war-room.tsx:147` — <Modal open onClose={onClose} className="max-w-2xl"> with no closeOnBackdrop={false}
- `src/components/strategy-war-room.tsx:124-130` — unmount cleanup calls controller.abort()
- `src/components/modal.tsx:15,24-28` — closeOnBackdrop defaults to true; the doc comment names the discard-input case
- `src/components/modal.tsx:38-51` — global Escape keydown calls onClose unconditionally
- `src/components/modal.tsx:74` — backdrop onClick={onClose}
- `src/app/api/tasks/generate-swarm/route.ts:82-84` — cancel() aborts the swarm's AbortController
- `src/lib/agent-swarm.ts:282,284,313` — abort checks return before finalizeConsensus and persistSwarmTasks
**Location in app:** AI Copilot panel → Refresh Task Map → Strategy War Room modal, mid-run. (No screenshot: absence finding.)
**What you see:** While the three agents are still debating, pressing Escape or clicking anywhere outside the window closes it instantly. There is no confirmation and no note that anything is still running. The board is unchanged and there is no way to get the run back — you start again from nothing. Nothing on screen ever says the run takes about a minute, and there is no cancel button, so reaching for Escape is the natural thing to do.
**Why wrong:** The modal is opened with default dismissal behaviour, so both a backdrop click and the global Escape handler close it. Closing unmounts the component, which aborts the stream; the server then aborts the debate and skips saving entirely, discarding six sequential model calls. The modal component's own documentation says to disable backdrop dismissal when a stray click would discard typed input — discarding a minute and a half of model work is strictly worse.
**Fix per doc:** In src/components/strategy-war-room.tsx:147 pass closeOnBackdrop={false} to Modal, and wrap the onClose passed in so that while status === "running" it asks for confirmation (or expose an explicit Cancel button in the footer next to the console). Add the expected duration to the intro copy at lines 171-174 ("about a minute") and render elapsed time or a round counter — the round_start event already carries round and totalRounds and is handled at line 53-55, so the counter is free.
**Systems touched:** strategy war room, modal component, swarm abort path

---

## F94 · MEDIUM · Track A
**Screenshot:** screenshots/F094.png
**Title:** On a phone the Copilot opens as a sliver and the four actions sit below the fold
**Where:**
- `src/components/copilot-dock.tsx:43` — fixed ... bottom-[54px] h-[35vh] with no resize affordance
- `src/components/copilot-dock.tsx:44,47-56` — the tab that opens it; only onCollapse closes it
- `src/components/chatbot-widget.tsx:516` — 53px header inside the sheet
- `src/components/chatbot-widget.tsx:608-611` — input bar, roughly 63px with padding
- `src/components/chatbot-widget.tsx:234-335` — the welcome column: greeting, form, dividers, four py-3 cards, chip row
- `src/components/client-rail.tsx:246` — the sibling mobile Company sheet uses fixed inset-0 with an X to dismiss
**Location in app:** AI Copilot panel → mobile and tablet bottom sheet
**What you see:** Tap the "AI Copilot" tab above the bottom navigation and a sheet slides up to about a third of the screen height. On a typical phone that leaves roughly 170 pixels between the header and the input bar. The greeting bubble and the "Describe a task you need done..." row fill essentially all of it, so the four AI actions and the three suggested questions are only reachable by scrolling inside that sliver — and it sits on top of whatever page you were reading.
**Why wrong:** The welcome column is around 450 to 500 pixels tall (greeting, task form, two dividers, four cards with gaps, chip row) inside about 170 pixels of visible space. The panel's entire value proposition is invisible on first open on a phone, and there is no way to make it bigger: the height is fixed with no drag handle and no full-screen option — unlike the sibling Company sheet in the left rail, which takes the whole screen.
**Fix per doc:** In src/components/copilot-dock.tsx:43 raise the sheet to about 70dvh, or make it full-screen following the pattern at src/components/client-rail.tsx:246 (fixed inset-0 flex flex-col with an X header) — the widget already renders an onCollapse control in its header (src/components/chatbot-widget.tsx:534-543) so dismissal is already wired. Independently, in src/components/chatbot-widget.tsx trim the greeting at lines 240-245 to one line and lay the four action cards out as a two-by-two grid below the lg breakpoint (line 303) so they land above the fold.
**Systems touched:** copilot dock (mobile sheet), chatbot widget layout, responsive design

---

## F95 · MEDIUM · Track A
**Title:** The copilot is given a credit price list that omits the most expensive thing a client can buy
**Where:**
- `src/app/api/clients/[id]/chat/route.ts:161` — the Costs line: chat, task execution, blog, newsletter, social, landing page, doc correction
- `src/app/api/clients/[id]/chat/route.ts:165` — "Never invent credit figures beyond these."
- `src/app/api/clients/[id]/chat/route.ts:637` — the copilot's four tools: branding, support email, gmail context, create tasks; nothing exposes credit pricing
- `src/lib/credits.ts:57` — customAgentRun = 25, omitted from the appendix
- `src/lib/credits.ts:62` — employeeSeat = 100, omitted
- `src/components/custom-agents.tsx:85` — the run price the client is actually charged (agent.creditCost ?? CREDIT_COSTS.customAgentRun)
**Location in app:** Client copilot dock (all client pages) — credit questions. (No screenshot: absence finding.)
**What you see:** A client asks the copilot "how much does running the LinkedIn agent cost?" It has been handed prices for chat messages, task executions, blog articles, newsletters, social posts, landing pages and doc corrections — and then told never to give any figure beyond those. So it either declines or quotes the generic task-execution baseline of 5, when the actual charge is 25 per output.
**Why wrong:** Custom agent runs are the dominant client spend and the only thing the Agents page charges: 25 credits per output by default, or a per-agent override, plus 100 for an over-limit LinkedIn seat. Neither figure appears in the price appendix, and the copilot has no tool that could look them up. The explicit no-inventing instruction turns the gap into either a refusal or a confidently wrong low number, right before the client commits to a run.
**Fix per doc:** Extend the creditsAppendix in src/app/api/clients/[id]/chat/route.ts:161-164 with `custom agent run ${CREDIT_COSTS.customAgentRun} per output (some agents are priced individually — check the agent card)` and `extra LinkedIn employee seat ${CREDIT_COSTS.employeeSeat}, one-time`. Better: the route already loads the client, so also list that client's granted agents with their creditCost overrides (the same values custom-agents.tsx:85 renders) and quote those exact figures instead of the default.
**Systems touched:** AI copilot system prompt, credits, custom agents pricing

---

# Client dashboard section (section intro, p153)

"The first screen a client sees. It opens with duplicated counters and ends with a demo-data briefing that gives real budget advice." 7 findings: #97, 125, 99, 124, 126, 145, 100. (#100 falls past p160.)

---

## F97 · BLOCKER · Track B
**Title:** The client's top call to action promises an approval they cannot make, and the link lands on the wrong screen
**Where:**
- `src/components/client-home-overview.tsx:42`
- `src/components/client-home-overview.tsx:80-84`
- `src/app/(app)/assets/page.tsx:24`
- `src/components/progress-view.tsx:39`
- `src/lib/actions/asset-actions.ts:133`
- `src/components/asset-detail-modal.tsx:273`
- `src/app/(app)/clients/[id]/assets/page.tsx:17-19`
- `src/components/client-home-overview.tsx:80` — href="/assets?view=library&status=draft"
- +3 further references in the verification record
**Location in app:** Client Dashboard (/clients/[id]) → Workspace (/tasks). (No screenshot: absence finding.)
**What you see:** A client logs in and the first card says "3 posts awaiting your approval — Review and approve to keep content moving." They click it and land on the Workspace task board: a column of tasks, no drafts, no filter, nothing about the three posts. If they hunt around, find the Archive tab and open a draft tile, the panel offers Copy, Download and "Already posted it?" — there is no Approve anywhere, and there never can be, because approval is deliberately reserved for the Karos team.
**Why wrong:** Three separate breaks stack up. The count comes from agent runs sitting in review, but the link filters deliverables by draft — different data. The link target bounces every client user to the task board and throws the filter away. The tab the drafts actually live on is held in local component state, so no link can ever open it. And the approve action itself is staff-only by explicit design (the comment says letting a client approve would also let them arm auto-publish), so the sentence describes a loop that has no code path for a client. This is the portal telling a paying client to do something the portal will not let them do.
**Fix per doc:** Two edits, in this order. (1) src/components/progress-view.tsx:39 — replace `useState<View>("board")` with URL-driven state (`useSearchParams()` for the initial value plus `router.replace("?tab=archive")` on change, default "board") so board/activity/archive become linkable. (2) src/components/client-home-overview.tsx:80-84 — repoint `href` to `/tasks?tab=archive` and rewrite the AttentionRow label/hint to match reality: label `${n} deliverable(s) in review`, hint "Your Karos team is reviewing these — they'll appear in your archive when ready." Also fix the count source at line 42 so the number matches what the link shows (count draft assets, or keep counting review jobs and say "runs in review"). Do NOT add an Approve control to AssetDetailModal: approveAssetAction calls requireStaff at src/lib/actions/asset-actions.ts:133 precisely so a client cannot approve and arm auto-publish.
**Also reported as:** "N posts awaiting your approval" on the client dashboard bounces to a different page and drops the filter.
**Systems touched:** client dashboard, workspace/task board, assets/archive, asset approval permissions

---

## F125 · BLOCKER · Track B
**Screenshot:** screenshots/F125.png
**Title:** AI Insights is badged "Demo data" and still tells the client to cut LinkedIn spend
**Where:**
- `src/components/ai-insights.tsx:18-21, :89` — the demo-data badge, set from the X-Insights-Data-Source: mock response header
- `/api/clients/[id]/insights` — serves deterministic mock metrics when no live social token exists
**Location in app:** Client dashboard (/clients/[id]) → AI Insights
**What you see:** Under a "Beta" + "Demo data" badge: "Activity dropped sharply: zero posts this week vs. 8 last week (−100%)... Instagram dominates... Reduce LinkedIn spend — 1 post, weak signal; focus budget on Instagram until data grows." Instagram is not one of this client's connected channels — the card above lists Google, LinkedIn and YouTube.
**Why wrong:** A small warning chip does not offset three paragraphs of specific, numbered budget advice derived from invented figures about a channel the client does not use. The badge is honest; the content is not.
**Fix per doc:** When the header is mock, do not render a briefing at all: show the empty state ("Connect a social account and we'll brief you weekly on what's working") with the connect link, and gate the demo prose behind a staff check. Separately, filter the prompt's channel list to the client's connected channels so it cannot recommend a channel they do not have.
**Systems touched:** AI insights, insights API (mock data), client dashboard

---

## F99 · MEDIUM · Track A
**Screenshot:** screenshots/F099.png
**Title:** The client dashboard is one unbroken scroll and the plain-English weekly briefing sits dead last
**Where:**
- `src/app/(app)/clients/[id]/page.tsx:81-119`
- `src/components/seo-geo-panel.tsx:281-513`
- `src/components/client-analytics.tsx:121-136`
- `src/components/client-analytics.tsx:45-50`
- `src/components/ui.tsx:245-253`
**Location in app:** Client Dashboard (/clients/[id])
**What you see:** A large "Welcome back" banner, then two overview cards, then four stat tiles plus two cards plus a whole bordered panel holding a single sentence about agent runs, then three score tiles and six more full-width panels of search and AI visibility — and only then the streamed briefing that explains what changed this week and what the team is doing about it. On a laptop that is roughly five screens of scrolling, everything expanded, nothing collapsed, no in-page navigation.
**Why wrong:** Every section renders at full detail at once, in the reverse of value order: the two things a client most wants — the weekly briefing and the fix list — are the deepest, while the shallowest element is a large heading that carries no information. One bordered panel is spent on a single sentence that would fit as a fifth stat tile.
**Fix per doc:** In src/app/(app)/clients/[id]/page.tsx: move the AI Insights section (lines 113-118) to directly after the Overview section (ends line 90) so the briefing sits above Performance; render the fix list as its own section right below it once finding 4's swap is in. Put the remaining heavy sections (Performance, Search & AI visibility) behind a segmented control copied from src/components/progress-view.tsx:42-67 with the active tab in a `?tab=` param. Reduce the client PageHeader at lines 73-77 to a single small line. In src/components/client-analytics.tsx delete the standalone Agent activity Card (121-136) and add its run count as a fifth StatCard in the row at 45-50, changing that grid to five columns.
**Systems touched:** client dashboard layout, client analytics, seo-geo panel

---

## F124 · MEDIUM · Track A
**Screenshot:** screenshots/F124.png
**Title:** The dashboard opens with four counters that the two cards beneath them restate
**Where:** the stat-tile row and the two cards below it on the client dashboard page
**Location in app:** Client dashboard (/clients/[id]) — top of page
**What you see:** Four tiles: Published 14, Scheduled 0, Channels 3, Deliverables 21. Directly beneath, "Content by status" repeats Published 14 (plus Draft 4, Approved 3) and "Connected channels" lists the same three channels. Deliverables 21 is 14 + 4 + 3.
**Why wrong:** A full screen of duplicated counters before anything actionable. The scores, the fix list and the failing agent — the things worth reacting to — are all below the fold.
**Fix per doc:** Drop the Published and Channels tiles, keep Scheduled and Deliverables in one thin summary row, and lift the three score tiles plus a "needs your attention" block above the fold.
**Systems touched:** client dashboard layout

---

## F126 · MEDIUM · Track A
**Screenshot:** screenshots/F126.png
**Title:** Single-asterisk emphasis renders as literal asterisks in AI Insights
**Where:**
- `src/components/ai-insights.tsx:139` — line.split(/(\*\*[^*]+\*\*)/g) matches only the double form
- `src/components/ai-insights.tsx:131-135` — the comment states the renderer exists precisely to stop raw syntax reaching the page
**Location in app:** Client dashboard (/clients/[id]) → AI Insights
**What you see:** Intermittent, depending on what the model emits. An earlier generation rendered "Top performers: *Playbook* (4.2 score, 6.8% engagement) and *Special Edition*" with the asterisks visible. The current generation happens to use quotation marks, so the card looks clean right now.
**Why wrong:** The renderer handles **bold**, headings and bullets but not single-asterisk emphasis, so whenever the model reaches for italics the syntax lands on the page. It is latent rather than always visible, which is why it survived review.
**Fix per doc:** Extend the split to /(\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g and render single-delimiter spans as <em>. Add a test asserting no * or # survives into rendered output — the presenter's no-leak test is the model to copy.
**Systems touched:** AI insights renderer

---

## F145 · MEDIUM · Track A · CONTINUES past p160
**Screenshot:** screenshots/F145.png
**Title:** A channel whose token dies silently vanishes from "Connected channels" instead of asking to be reconnected
**Where (as visible through p160):**
- `src/components/client-analytics.tsx:32` — activeChannels = integrations.filter(integrationIsUsable) — dead channels dropped
- `src/components/client-analytics.tsx:110-113` — hardcoded neon "Connected" badge for every remaining row
- (WHERE list and FIX continue past p160)
**Location in app:** Client dashboard (/clients/[id]) → Connected channels
**What you see:** The card lists Google, Linkedin, Youtube — every row with the same green "Connected" badge. The card asked: "Connected channels — is this accurate or not? Is LinkedIn actually working?" The honest answer: rows that show are genuinely usable, but a channel whose token has expired is filtered out of the list entirely — it just disappears, and the "Channels" stat drops by one with no explanation.
**Why wrong:** The health truth exists — the integration layer has expired/reauthenticate states and the Settings tab renders a "Reconnect needed" chip — but the dashboard shows only healthy rows, so a dead LinkedIn reads as "not set up" rather than "broken, click to fix". The client's first question ("is LinkedIn working?") is exactly the one this card silently refuses to answer. Bonus: the badge's icon name CheckCircle2 is one of the eight missing lucide names, so the check mark is actually the sparkle fallback (finding 63).
**Fix per doc:** CONTINUES past p160 — fix text not in this page range.
**Systems touched:** client dashboard, connected channels card, integrations health states, icons
