# x-agent-v2 — karosCMO integration contract

For the karos-agents lab team (PR #28, `products/building/x-agent-v2/`).
karosCMO now has storage and plumbing in place for the five blockers raised in
the storage doc; this is the contract your Setup and Weekly skills need to
follow for each one to actually take effect. Portal-side implementation:
[docs/x-agent-portal.md](../x-agent-portal.md) is the existing e13 contract this
extends; nothing there changes except where noted below.

## 1. Onboarding answers — no longer your input, read-only reference only

Handle, off-limits and "how they want to come across" now live in a portal
`clientContextDocs` document, not `agentIntake`. They still reach every run the
same way as before — inside `x-portal-intake.md`'s `## Company page` / `## Seat
— <name>` sections, in `client_context/files/`. Nothing to change on your side;
this is portal-internal storage plumbing (blocker 1).

## 2. Voice-profile artifact naming (blocker 2)

The Setup (launch) run may emit **one file per seat** it built a voice profile
for:

```
voice-profile--<seat-slug>.md
```

- `<seat-slug>` must match the kebab-case slug the portal already assigns each
  seat (the same slug used in `takes--<slug>.json` today — read it back from
  `x-portal-intake.md`'s `- Person: <name> (slug: <slug>)` line for that seat).
- **Mark this artifact `client_facing: true`.** Launch-run deliverables are
  already excluded from every client-visible surface on the portal side
  (`launchDeliverable: true`), so this does not expose anything to the client —
  it's what makes the portal's webhook fetch and store the file's content at
  all. A non-client-facing artifact is never downloaded and will be silently
  dropped.
- Content is freeform markdown — whatever the sweep produced. It's stored
  verbatim and re-attached to every future run as `voice-profile--<slug>.md` in
  `client_context/files/`, the same way `whats-new.json`/`takes--*.json` are
  today.
- One file per seat swept; a seat with no voice profile built yet simply has no
  file — unlike the weekly inputs below, a missing voice-profile file is a
  normal "not built yet" state, not an error signal.

## 3. Weekly inputs are now always present, never missing (blocker 3)

`whats-new.json` and every seat's `takes--<slug>.json` are now uploaded on
**every** run once the client has any intake/seats configured — including a
quiet week with nothing typed. You will see:

```json
{ "updates": [] }
```

or

```json
{ "takes": [] }
```

instead of the file being absent. **Update the skill to treat an empty array as
"quiet week, nothing new" and a missing file as a real error** (broken context
injection) — before this change, both cases looked identical (no file), so if
your skill currently treats "no whats-new.json" as "nothing to report," no
change is needed on your side; if it currently treats a missing file as an
error condition, that check will now correctly fire only on an actual pipe
break.

## 4. Pick / edit diff in the Learning Log (blocker 4)

`posted_with_edits` rows in the per-account Learning Log (the feedback section
of `x-portal-intake.md`) now carry both sides of the edit, when available:

```
- 2026-07-30: posted with edits on "Avenue 3 · News-reaction". Original: <drafted text> → Final: <what the client actually posted>
```

Older rows (or rows where the original couldn't be recovered) still fall back
to the previous single-line format (`Final text used: ...`). No format change
needed on your side — this is additive detail in the same file/section.

## 5. Per-step model routing (blocker 5) — action needed if you want this

The portal can now send a `step_models` map in the job brief:

```json
{ "step_models": { "draft-post": "claude-haiku-4-5", "research": "claude-opus-4-8" } }
```

**For a step's model override to take effect, that step must be invoked as a
named Task-tool subagent whose name exactly matches the map's key** (e.g. your
skill's step logic calls the Task tool with `subagent_type: "draft-post"`).
karosCMO turns each `step_models` entry into an `options.agents[name] = {
model }` definition passed to the Claude Agent SDK's `query()` call — this is
model-only; it does not know or set your subagent's actual system prompt or
tool access.

**Open question we could not resolve without your skill's source**: whether the
SDK's `agents` option merges with or replaces a same-named subagent your skill
may already define via its own filesystem convention (e.g.
`.claude/agents/<name>.md`). If x-agent-v2's steps already use named Task-tool
delegation with their own defined prompts, confirm with us whether the model
override composes cleanly before relying on this in production — worst case,
avoid reusing a `step_models` key that collides with a subagent name whose
prompt matters, until that's verified.

If most of your 16 weekly steps are mechanical file work (as you flagged),
routing those specific step names to a cheaper model via this map is exactly
what it's for — we just need your confirmation on the subagent-naming
structure above before it's safe to lean on at scale.

## Contacts / next steps

- Portal-side changes are live now (types, storage, webhook, submit path).
- We need from you: (a) confirm whether x-agent-v2's steps use named
  Task-tool subagents, and if so their names, so we can validate #5 together;
  (b) start emitting `voice-profile--<slug>.md` on Setup runs per #2; (c) no
  action needed for #1/#3/#4 — those are portal-internal.
