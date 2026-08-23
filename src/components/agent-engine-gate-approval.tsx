"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner, Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { normalizeDashes } from "@/lib/text-utils";
import { resolveAgentEngineGateAction } from "@/lib/actions";

/**
 * The human-approval action for an agent-engine run paused at
 * `awaiting_gate` — Task 3's "paused runs render human approval actions
 * triggering gate resolution via agent-engine." Distinct from the legacy
 * `ApprovePanel` (which approves an already-finished `Asset`, post
 * completion): this approves/rejects a run that is mid-flight, still
 * holding a Pub/Sub-derived `agentEngineRunId`, before it can continue.
 *
 * IT USED TO SHOW THE REVIEWER NOTHING TO REVIEW. The whole component was one
 * line — "This run is paused waiting on your review of gate
 * '15-batch-review'" — plus Approve and Reject. Every workflow that opens a
 * gate already puts the thing being decided in the gate's own `payload`
 * (x-agent: the topic, the lane, the angle and the drafted post text;
 * linkedin: topic and archetype; reddit: the target thread; intel: the
 * dimension scores and SWOT), `readAgentEngineRun` already fetches that whole
 * record to decide the run is paused, and the panel then passed only the
 * `gateId` down. So an account manager pressed Approve on a draft they had
 * never seen, and the run recorded their name against it.
 *
 * THE RENDERER IS GENERIC ON PURPOSE, not a per-product table. Eleven products
 * open gates of six different `kind`s with six different payload shapes, and a
 * lookup table keyed by product would silently show nothing for the twelfth.
 * Three rules cover all of them: `preview` (the convention every drafting
 * workflow uses for the actual deliverable text) renders as the prose block a
 * reviewer reads first; every other scalar renders as a labelled fact; anything
 * structured renders as collapsed JSON. A payload key nobody anticipated still
 * reaches the screen.
 */

/** Already shown in the page header and the run panel — repeating it here costs a row and tells the reviewer nothing. */
const SUPPRESSED_KEYS = new Set(["runId", "preview", "client"]);

/** The gate `kind`s the engine opens today, in words. An unrecognised kind falls back to its own raw id rather than to silence. */
const GATE_KIND_LABELS: Readonly<Record<string, string>> = {
  batch_review: "Draft review",
  campaign_review: "Campaign review",
  branded_shorts_delivery_review: "Video delivery review",
  prompt_set_review: "Prompt set review",
  fix_generation_review: "Fix generation review",
  publish_approve: "Publish approval",
};

function labelForKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function AgentEngineGateApproval({
  jobId,
  gateId,
  kind,
  payload,
  requiredRole,
}: {
  jobId: string;
  gateId: string;
  /** The gate's own `kind` from its record — what sort of decision this is. */
  kind?: string;
  /** The gate's `payload`, verbatim. Arbitrary by contract, so it is read defensively and never asserted into a shape. */
  payload?: unknown;
  requiredRole?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  function resolve(decision: "approve" | "reject") {
    startTransition(async () => {
      const result = await resolveAgentEngineGateAction(jobId, gateId, decision, notes || undefined);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  const fields = isRecord(payload) ? payload : {};
  const preview = typeof fields["preview"] === "string" ? fields["preview"].trim() : "";
  const facts: Array<[string, string]> = [];
  const structured: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (SUPPRESSED_KEYS.has(key) || value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      facts.push([labelForKey(key), String(value)]);
    } else {
      structured.push([labelForKey(key), value]);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="Eye" className="h-4 w-4 shrink-0 text-warning" />
        <span className="text-sm font-medium">{kind ? (GATE_KIND_LABELS[kind] ?? labelForKey(kind)) : "Review"}</span>
        <Badge tone="neutral">{gateId}</Badge>
        {requiredRole && <Badge tone="neutral">{labelForKey(requiredRole)}</Badge>}
      </div>

      {/* The deliverable itself, when the gate carried one. Deliberately not a
          disclosure and deliberately first: it is the thing being approved, and
          a reviewer should not have to open anything to see it. */}
      {preview && (
        <div className="rounded-md border border-border bg-surface p-3">
          <p className="mb-1.5 text-xs text-muted-2">Awaiting your approval</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{normalizeDashes(preview)}</p>
        </div>
      )}

      {facts.length > 0 && (
        <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-2">{label}</dt>
              <dd className="truncate text-sm" title={value}>
                {normalizeDashes(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {structured.map(([label, value]) => (
        <details key={label} className="rounded-md border border-border/60 bg-surface-2/40">
          <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-muted">{label}</summary>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/60 p-2.5 text-[11px] leading-relaxed text-muted">
            {stringify(value)}
          </pre>
        </details>
      ))}

      {!preview && facts.length === 0 && structured.length === 0 && (
        <p className="text-xs text-muted-2">
          This gate carried no payload — approve or reject on the run&apos;s step history above.
        </p>
      )}

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional notes"
        rows={2}
        className="w-full rounded-md border border-border bg-surface p-2 text-sm"
        disabled={pending}
      />
      {error && <span className="text-xs text-danger">{error}</span>}
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={pending} onClick={() => resolve("approve")}>
          {pending ? <Spinner className="h-4 w-4" /> : "Approve"}
        </Button>
        <Button variant="danger" disabled={pending} onClick={() => resolve("reject")}>
          {pending ? <Spinner className="h-4 w-4" /> : "Reject"}
        </Button>
      </div>
    </div>
  );
}
