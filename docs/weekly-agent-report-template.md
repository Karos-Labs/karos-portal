# The weekly agent report — fixed template

**SCRUM-352 (L2 M9).** Filled in once a week from the change log. Two sections,
always in this order, and neither is optional: **what was improved in the app**,
and **what requires development**.

> **One thing to confirm before this is adopted.** The ticket points at
> "section 06 of the playbook", and the L2 Operator Playbook is not in any of
> the three repositories. This template is therefore **reconstructed** from what
> the report has to be able to carry — M5's rubric and its four classifications
> (SCRUM-347), and the reporting vocabulary in
> `docs/direction-2026-09-15/karos-learning-loop-and-reporting.md` §4. If the
> playbook's own section 06 differs, that one wins and this file should be
> replaced rather than argued with.

## Why the shape is the shape

The ticket says it plainly: *"without the template the report isn't actionable;
with it, each line becomes a dev task within minutes."* So every rule below
exists to make one row of section 2 paste-able into a ticket without anyone
having to go back and ask a question.

Three rules follow from that, and they are the whole method:

**A finding names the run it came from.** Not "the LinkedIn output was generic"
but a run id. A finding without one cannot be re-read, re-run, or checked after
a fix, and a week later nobody can tell whether it is still true.

**A change carries a before and an after.** An improvement with no numbers is a
claim. The columns are there because the thing that makes this report worth
writing is being able to say next month whether the work paid.

**Every finding in section 2 carries one of M5's four classifications**, and
they are not interchangeable — they route to different people and different
kinds of fix:

| classification | means | goes to |
|---|---|---|
| **prompt** | the instruction was wrong or missing | Studio, this week |
| **model** | the instruction was right and the model could not carry it | Studio, this week |
| **missing client knowledge** | the agent was never told something it needed | dev — grounding, the context docs, the learning loop |
| **agent structure** | no prompt or model fixes this; the steps are wrong | dev — the workflow |

M5 (SCRUM-347) adds the one instruction worth repeating here, because it is the
finding the report exists to surface: **generic output — output that could have
been written for any company in the space — is almost always "missing client
knowledge", not "prompt".** The reflex is to rewrite the prompt, and the prompt
is usually fine. If a week's report classifies several generic-output findings
as `prompt`, that is itself the finding.

---

## The template

Copy everything below this line.

---

# Weekly agent report — week of YYYY-MM-DD

**Runs reviewed:** N across M agents · **Findings:** N · **Shipped this week:** N

*(One sentence on the week. The thing a reader would want to know if they read
nothing else — not a summary of the table.)*

## 1 · Improved in the app

Changes made in Studio this week: prompt edits and model changes. Nothing that
needed a deploy.

| agent | step | what changed | before | after | cost before → after | quality |
|---|---|---|---|---|---|---|
| | | | | | | |

**Columns, briefly.** *before* / *after* are the observable thing, not the diff
— "opened with a question in 4 of 5 runs" → "0 of 5". *cost* comes from the
run's own report. *quality* is a judgement and should say whose.

**A change that made things worse belongs in this table too**, with the revert
noted. A report that only lists wins stops being read as evidence, and the
reverts are the most useful rows in it a month later.

## 2 · Requires development

Sorted by impact, highest first. Each row is a ticket that does not exist yet.

| # | finding | run id | agent · step | classification | impact | proposed ticket |
|---|---|---|---|---|---|---|
| 1 | | | | | | |

**Impact** is stated as what it costs, in whatever unit is honest: clients
affected, runs affected, dollars, or "a client would notice". Not high/medium/low
— those compress away the thing the sort needs.

**Proposed ticket** is a title and one line of scope. If it cannot be written in
one line, the finding is not understood well enough to hand over yet, and it
belongs in section 3 instead.

## 3 · Still open from previous weeks

| # | finding | first reported | status |
|---|---|---|---|
| | | | |

**This section is the point of writing the report weekly.** A finding that
appears here four weeks running is telling you something the individual reports
cannot: either nobody owns it, or it was misclassified and the fix is not the
one proposed. Say which.

## 4 · What was not reviewed

*(Which agents had no runs this week, and why. An agent missing from section 1
because it was never run is a completely different fact from an agent that ran
clean, and a reader cannot tell them apart unless this section says so.)*

---

## Filling it in

**Source:** the change log, plus the M5 audit rows for the week (SCRUM-347).

**Cadence:** weekly, Phase 3 of the L2 playbook.

**Where the numbers come from.** Cost per run is on the run's own report.
Modelled cost per agent and the per-step rate table are in
`karos-agent-benchmark.xlsx` and `agent-middleware/docs/step-cost-inventory.md`
(SCRUM-195 / SCRUM-346) — useful for section 1's cost column when a model swap
is the change, because the rate difference is known even before the run.

**How long it should take.** If it takes more than half an hour, the change log
is not being kept during the week, and that is the thing to fix rather than the
report.
