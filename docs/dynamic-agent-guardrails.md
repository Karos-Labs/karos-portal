# Dynamic Agent Studio — topic guardrails & output de-duplication

Canonical contract for the two Dynamic Agent Studio safety features added 2026-08:

1. **Topic guardrails** — the client's forbidden topics are injected into every AI step, and a
   mandatory verification pass at the end of the run checks the deliverable did not pick one.
2. **Output de-duplication** — an opt-in agent is shown what it already produced for this client
   and instructed not to repeat it, then the produced text is scored against that history.

This document pins the data shapes, the decisions behind them, and the exact zero-impact
guarantee. Change the code and this document in the same commit.

---

## 0. The non-negotiable: zero impact when unconfigured

Both features are **inert by default**, and that is the property every design decision below
serves. Concretely:

| Feature | Off when | What runs when off |
|---|---|---|
| Topic guardrails | the client has no `forbiddenTopics` | nothing — prompts are byte-identical to before, no verification call, no extra cost |
| Output de-duplication | the agent has `dedupeAgainstHistory !== true` | nothing — no history read at submit time, no injection, no scoring |

An existing client with no forbidden topics running an existing agent with the flag off gets a
run that is indistinguishable, byte for byte and cost for cost, from the same run before this
work. This is asserted by tests, not just intended.

---

## 1. Where each setting lives, and why

### 1.1 Forbidden topics are a property of the **client**

`Client.forbiddenTopics?: string[]`.

The subject of the sentence "topics the company does not engage with" is the *company*, not the
agent. A client that will not discuss, say, competitor pricing or a pending legal matter must be
protected on **every** agent it runs, including agents authored after the policy was set. Putting
the list on the agent would mean re-entering it per agent and silently losing the protection the
moment someone builds a new one.

Edited by staff on the client's Profile tab, through the existing `updateClientAction` — the same
write path, staff fence, and revalidation every other client field already uses. Stored as a
string array; the UI presents it as one topic per line.

Limits: **40 topics, 120 characters each**, de-duplicated case-insensitively. These are the same
order of magnitude as the Studio's own `MAX_INPUT_FIELDS`/`MAX_STEPS`, chosen so the injected
block cannot crowd out the admin's own prompt.

### 1.2 De-duplication is a property of the **agent**

`DynamicAgentSpec.dedupeAgainstHistory?: boolean`, default false, set in General settings.

The opposite reasoning applies. Injecting prior outputs changes what the model writes and costs
tokens on every run, so it is a genuine behaviour change and must be opted into per agent —
exactly like `allowNetwork` and `allowClientData`. It is also only *meaningful* for a
continuously-producing agent (a weekly post, a recurring newsletter); an agent that answers a
one-off question has no history worth avoiding.

Agent-level rather than step-level because de-duplication is a property of the run's
**deliverable**, not of any individual step. There is exactly one deliverable per run.

---

## 2. Topic guardrails

### 2.1 The "hard step" is an injection into every AI step, not a deletable pipeline step

The request was a fixed step that feeds the agent the forbidden topics. Implemented as a
constraint block appended by the **runner** to every AI step's composed prompt — the same
mechanism `allowClientData` already uses for client context.

This is deliberately *not* materialised as a step in `spec.steps`:

- A step in `spec.steps` is admin-editable and admin-deletable. A guardrail an admin can delete
  by clicking a bin icon is a convention, not a guarantee. The runner owns this one, so no
  Studio edit can remove it.
- A single front step's output is only visible to later steps if their prompts reference it.
  Injecting into *every* AI step removes that dependency on how the admin wrote their prompts.

Visibility is preserved without the fake step: the run report records `guardrail.injectedStepIds`,
and the job page renders a dedicated Guardrails card. An operator can see exactly which steps
carried the constraint.

### 2.2 Verification is a real, engine-appended final pass

After the pipeline succeeds, and only when the client has forbidden topics, the runner makes one
extra model call: it receives the final deliverable and the topic list, and returns structured
JSON naming any topic the output actually engages with, plus a short evidence quote.

- **Model: haiku.** This is classification, and the house model-routing rule puts classification
  on haiku. It also keeps the added cost of the feature near-zero.
- **Runs on success only.** A failed run has no deliverable to verify; verifying partial output
  would produce findings about text no one will ever ship.
- **Not retried.** A verification that fails is recorded as `status: "error"` and surfaced; it
  does not consume the run's retry budget.

### 2.3 A violation blocks the run (updated 2026-08)

**Decision: a violation stops the run before it ever becomes a client-visible asset.** The
verification pass runs on the finished deliverable, but strictly *before* the client-facing
output file is written and before artifacts are uploaded. If it reports `status: "violation"`,
`run-dynamic-job.ts` returns `outcome: "failed"` instead of `"done"`:

- The artifact/asset pipeline is gated on `outcome === "done"` (`webhook route.ts`), so a blocked
  run creates **no asset at all** — not even a draft.
- `refundJobCharge` already runs for every non-`"done"` outcome, so the client is refunded exactly
  like any other failed run — no charge is kept for blocked content.
- The offending draft is **not discarded**: it is preserved under the run's internal trace
  (`internal/blocked-output.md`) for staff review, and a `client/BLOCKED.md` marker explains why
  nothing was delivered — mirroring the existing `INCOMPLETE.md` convention for a failed step.
- The job's timeline still gets the guardrail event (`guardrailEvents` in `webhook route.ts`) and
  the job page's Guardrails card still renders `dynamicRun.guardrail`, so staff can see exactly
  which topic fired and the evidence quote, even though the run shows as failed.

This supersedes the original "flags, never fails" design (kept below for history). The original
grounds for flag-only were: (1) it preserved paid-for work that might be 95% usable, (2) it kept a
false positive from the verifier merely annoying rather than destructive, and (3) it avoided
coupling job status to a guardrail finding. Those tradeoffs were revisited in favor of a hard
guarantee that forbidden-topic content is never even offered as a draft — a false positive now
costs a re-run (and the client is refunded automatically) rather than risking a human missing the
flag and approving the draft anyway.

**The verifier still fails open, loudly.** If the verification call errors or returns unparseable
JSON, the status is `"error"` — never `"violation"`, and the run still succeeds normally. A broken
verifier must not manufacture violations against good output, and it must not block real,
compliant work either; instead the error is displayed so staff know the check did not run.

Output de-duplication is unaffected by this change: a `"similar"` finding still only flags, never
blocks — it is a similarity signal for a human to weigh, not a correctness violation.


---

## 3. Output de-duplication

### 3.1 History is gathered at submit time, in the Portal

`buildDynamicAgentHistory(specId, clientId)` mirrors the existing `priorBatchFiles` pattern the X
/ LinkedIn / Reddit agents already use: list the client's jobs, keep those from this same spec
that reached a terminal reviewed state and produced an asset, newest first, take the most recent
few, and read each one's asset content.

- **`dynamicAgentSpecId` is the filter key**, which is stronger than the `agentName` the
  hardcoded agents must fall back on — a renamed agent keeps its history.
- **5 runs, 4,000 characters each.** Enough for the model to recognise repetition, bounded so the
  injected block cannot dominate the prompt or the payload.
- Frozen onto the payload at submit time, like everything else the run executes, so history
  cannot shift mid-flight.

Delivered inline on the brief rather than as an uploaded context file: it is small and bounded,
and an inline field avoids a storage write plus a download on every run.

### 3.2 Injected into the final AI step only

Every earlier step is extraction, research, or analysis — repetition there is harmless and often
correct. Only the step that writes the deliverable needs to know what not to repeat, so only it
pays the token cost. If the last step is a code step, nothing is injected.

### 3.3 Scoring is deterministic, not a second model call

`similarity.ts` computes **Jaccard overlap over word trigrams** of the normalised text
(lowercased, punctuation and whitespace collapsed).

Chosen over embeddings because it needs no external service, no API key, no new infrastructure,
and no network access from the runner — and because it is a pure function, so its behaviour is
pinned by unit tests rather than by a provider's model version. Near-identical text scores above
0.8; the same topic written afresh scores well under 0.2.

**Threshold: 0.40**, a named constant. Above it the run is flagged `status: "similar"` with the
most similar prior job id and the score. Same treatment as a guardrail violation: recorded and
rendered, never failing the run and never rewriting the deliverable.

---

## 4. Data shapes

Mirrored by hand between `src/lib/types.ts` (Portal) and `agent-service/src/dynamic-types.ts` /
`agent-service/src/types.ts`, per the existing rule that the two repos never cross-import.

```ts
// Client
forbiddenTopics?: string[];

// DynamicAgentSpec
dedupeAgainstHistory?: boolean;

// DynamicAgentJobPayload — frozen at submit time
guardrails?: { forbiddenTopics: string[] };
outputHistory?: { items: Array<{ jobId: string; createdAt: number; excerpt: string }> };

// DynamicAgentRunReport — what came back
guardrail?: {
  forbiddenTopics: string[];
  injectedStepIds: string[];
  verification?: {
    status: "clean" | "violation" | "error";
    violatedTopics: string[];
    evidence?: string;
    model?: string;
    durationMs: number;
  };
};
dedupe?: {
  status: "ok" | "similar" | "no_history";
  comparedCount: number;
  maxSimilarity: number;
  threshold: number;
  mostSimilarJobId?: string;
};
```

On the wire the brief carries `guardrails` and `output_history` (snake_case, matching the brief's
existing `step_models` / `spec_version` convention); `custom.json` declares both, since that
schema is `additionalProperties: false`.

---

## 5. Defect fixed alongside this work

The webhook's `dynamicRunSchema` did not declare the per-step `capabilities` field added with the
network / client-data grants. Zod strips undeclared keys, so the capability record the runner
produced was **silently dropped before it was stored on the job** — the audit trail those grants
promise did not survive ingestion. The schema now declares `capabilities`, `guardrail`, and
`dedupe`. A regression test asserts a report carrying all three survives a round trip.

---

## 6. Where each piece lives

| Concern | File |
|---|---|
| Topic list parsing / limits (pure) | `src/lib/dynamic-agent-guardrails.ts` |
| History assembly (server) | `src/lib/agent-service/dynamic-agent-history.ts` |
| Payload assembly | `src/lib/jobs/submit-custom.ts` |
| Client field write path | `src/lib/actions/client-actions.ts`, `src/components/client-editor.tsx` |
| Agent opt-in | `src/components/admin/agent-studio/general-settings-form.tsx` |
| Ingestion | `src/app/api/agent-service/webhook/route.ts` |
| Staff-facing render | `src/components/dynamic-agent-guardrail-report.tsx` |
| Prompt injection | `agent-service/runner/src/dynamic/step-runner.ts` |
| Verification pass | `agent-service/runner/src/dynamic/guardrail-verify.ts` |
| Similarity scoring (pure) | `agent-service/runner/src/dynamic/similarity.ts` |
| Orchestration | `agent-service/runner/src/dynamic/run-dynamic-job.ts` |
