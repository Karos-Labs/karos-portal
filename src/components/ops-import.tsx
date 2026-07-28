"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, CardTitle, EmptyState, Spinner } from "@/components/ui";
import { Icon } from "@/components/icon";
import { Modal } from "@/components/modal";
import {
  applyOpsBundleAction,
  planOpsBundleAction,
  type ApplyOutcome,
  type PlanSummary,
} from "@/lib/actions";
import { cn } from "@/lib/utils";

/**
 * Admin Ops Import — review a locally-produced bundle, then land it.
 *
 * PLAN BEFORE WRITE IS THE STRUCTURE, NOT THE COPY: there is no code path from
 * this component to a write that does not first render the dry-run diff. The
 * Import button only appears once a plan exists, and the server re-validates
 * the file from disk anyway — the plan shown here authorizes nothing.
 */

interface BundleRow {
  file: string;
  clientId: string | null;
  clientName: string | null;
  error: string | null;
  counts: { docs: number; competitorUpdates: number; competitorCreates: number } | null;
  hasSeoGeo: boolean;
}

type PlanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; plan: PlanSummary }
  | { status: "rejected"; errors: string[] };

type ApplyState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; outcome: ApplyOutcome }
  | { status: "failed"; errors: string[] };

export function OpsImport({ bundles }: { bundles: BundleRow[] }) {
  const [plans, setPlans] = useState<Record<string, PlanState>>({});
  const [applied, setApplied] = useState<Record<string, ApplyState>>({});
  const [confirming, setConfirming] = useState<PlanSummary | null>(null);
  const [bulk, setBulk] = useState<"idle" | "confirm" | "running">("idle");
  const [, startTransition] = useTransition();

  const planFor = (file: string): PlanState => plans[file] ?? { status: "idle" };
  const applyFor = (file: string): ApplyState => applied[file] ?? { status: "idle" };

  function loadPlan(file: string) {
    setPlans((p) => ({ ...p, [file]: { status: "loading" } }));
    startTransition(async () => {
      const res = await planOpsBundleAction(file);
      setPlans((p) => ({
        ...p,
        [file]: res.ok ? { status: "ready", plan: res.plan } : { status: "rejected", errors: res.errors },
      }));
    });
  }

  async function runApply(plan: PlanSummary) {
    setApplied((a) => ({ ...a, [plan.file]: { status: "running" } }));
    const res = await applyOpsBundleAction({
      file: plan.file,
      includeSeoGeo: plan.seoGeo?.ok === true,
    });
    setApplied((a) => ({
      ...a,
      [plan.file]: res.ok ? { status: "done", outcome: res.outcome } : { status: "failed", errors: res.errors },
    }));
    // The stored state just moved, so the rendered diff is now history.
    setPlans((p) => ({ ...p, [plan.file]: { status: "idle" } }));
  }

  /** Every bundle that has a rendered, unapplied, unlocked plan. */
  const readyPlans = bundles
    .map((b) => planFor(b.file))
    .filter((s): s is { status: "ready"; plan: PlanSummary } => s.status === "ready")
    .map((s) => s.plan)
    .filter((p) => !p.lockedReason && p.counts.totalWrites > 0 && applyFor(p.file).status === "idle");

  if (bundles.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="Inbox" className="h-6 w-6" />}
        title="The ops inbox is empty"
        description="Drop per-client proposal JSON files into OPS_IMPORT_DIR and reload this page."
      />
    );
  }

  return (
    <div className="space-y-4">
      {readyPlans.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3">
          <p className="text-sm text-muted">
            {readyPlans.length} reviewed bundle{readyPlans.length === 1 ? "" : "s"} ready to import.
          </p>
          <Button size="sm" variant="subtle" disabled={bulk === "running"} onClick={() => setBulk("confirm")}>
            {bulk === "running" ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="Download" className="h-3.5 w-3.5" />}
            Import all reviewed
          </Button>
        </div>
      )}

      {bundles.map((bundle) => (
        <BundleCard
          key={bundle.file}
          bundle={bundle}
          plan={planFor(bundle.file)}
          apply={applyFor(bundle.file)}
          onPlan={() => loadPlan(bundle.file)}
          onImport={(p) => setConfirming(p)}
        />
      ))}

      {/* Per-bundle confirm — names exactly what will be written. */}
      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Import into the live portal?"
        description={confirming ? `${confirming.clientName} · ${confirming.file}` : undefined}
        className="max-w-lg"
      >
        {confirming && (
          <div className="mt-4 space-y-4">
            <WriteManifest plan={confirming} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const plan = confirming;
                  setConfirming(null);
                  startTransition(() => void runApply(plan));
                }}
              >
                <Icon name="Download" className="h-3.5 w-3.5" /> Write {confirming.counts.totalWrites} change
                {confirming.counts.totalWrites === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Import-all confirm — the same manifest, per client. */}
      <Modal
        open={bulk === "confirm"}
        onClose={() => setBulk("idle")}
        title={`Import ${readyPlans.length} bundles into the live portal?`}
        description="Each client is written in its own atomic batch. A client that fails is reported, not retried."
        className="max-w-lg"
      >
        <div className="mt-4 space-y-4">
          <div className="max-h-[320px] space-y-3 overflow-y-auto">
            {readyPlans.map((p) => (
              <div key={p.file} className="rounded-md border border-border px-3 py-2.5">
                <p className="text-sm font-medium">{p.clientName}</p>
                <WriteManifest plan={p} compact />
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setBulk("idle")}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const queue = [...readyPlans];
                setBulk("running");
                startTransition(async () => {
                  // Sequential on purpose: each apply re-reads the state it
                  // validates against, and parallel batches would race.
                  for (const p of queue) await runApply(p);
                  setBulk("idle");
                });
              }}
            >
              <Icon name="Download" className="h-3.5 w-3.5" /> Import all {readyPlans.length}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** The confirm dialog's manifest: what lands, in nouns, before anything is written. */
function WriteManifest({ plan, compact }: { plan: PlanSummary; compact?: boolean }) {
  const lines: string[] = [];
  const docs = plan.docs.filter((d) => d.action !== "unchanged");
  for (const d of docs) lines.push(`${d.action === "create" ? "Create" : "Update"} document ${d.label}`);
  const comps = plan.competitors.filter((c) => c.action !== "unchanged");
  for (const c of comps) lines.push(`${c.action === "create" ? "Add" : "Update"} competitor ${c.company}`);
  for (const f of plan.profileFills) lines.push(`Fill client.${f.field}`);
  for (const f of plan.brandingFills) lines.push(`Fill brandingGuidelines.${f}`);
  if (plan.colors) lines.push(`Replace brand palette (${plan.colors.to.join(", ")})`);
  if (plan.seoGeo?.ok) lines.push(`Import SEO/GEO snapshot captured ${plan.seoGeo.capturedOn}`);

  return (
    <div className={cn("space-y-1.5", compact && "mt-1.5")}>
      {!compact && (
        <p className="text-xs text-muted-2">
          Nothing is deleted. Fields a human already filled are skipped, never overwritten.
        </p>
      )}
      <ul className="space-y-1 text-xs text-muted">
        {lines.map((l, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-muted-2">·</span>
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BundleCard({
  bundle,
  plan,
  apply,
  onPlan,
  onImport,
}: {
  bundle: BundleRow;
  plan: PlanState;
  apply: ApplyState;
  onPlan: () => void;
  onImport: (plan: PlanSummary) => void;
}) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>{bundle.clientName ?? bundle.file}</CardTitle>
          <p className="mt-1 font-mono text-xs text-muted-2">{bundle.file}</p>
          {bundle.counts && (
            <p className="mt-1.5 text-xs text-muted">
              {bundle.counts.docs} document{bundle.counts.docs === 1 ? "" : "s"} ·{" "}
              {bundle.counts.competitorUpdates} competitor update
              {bundle.counts.competitorUpdates === 1 ? "" : "s"} · {bundle.counts.competitorCreates} new
              {bundle.hasSeoGeo && " · SEO/GEO snapshot"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {bundle.hasSeoGeo && <Badge tone="info">seo/geo</Badge>}
          {apply.status === "done" && <Badge tone="success">imported</Badge>}
          {plan.status !== "ready" && apply.status !== "done" && (
            <Button size="sm" variant="subtle" disabled={plan.status === "loading" || !!bundle.error} onClick={onPlan}>
              {plan.status === "loading" ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Icon name="Eye" className="h-3.5 w-3.5" />
              )}
              Review changes
            </Button>
          )}
        </div>
      </div>

      {bundle.error && (
        <p className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {bundle.error}
        </p>
      )}

      {plan.status === "rejected" && <RejectionList errors={plan.errors} />}
      {plan.status === "ready" && <PlanCard plan={plan.plan} onImport={() => onImport(plan.plan)} />}
      {apply.status === "running" && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3.5 w-3.5" /> Writing…
        </p>
      )}
      {apply.status === "failed" && <RejectionList errors={apply.errors} />}
      {apply.status === "done" && <OutcomePanel outcome={apply.outcome} />}
    </Card>
  );
}

function RejectionList({ errors }: { errors: string[] }) {
  return (
    <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-sm font-medium text-danger">
        <Icon name="TriangleAlert" className="h-4 w-4 shrink-0" />
        Refused — {errors.length} problem{errors.length === 1 ? "" : "s"}. Nothing was written.
      </p>
      <ul className="mt-2 space-y-1">
        {errors.map((e, i) => (
          <li key={i} className="font-mono text-[11px] leading-relaxed text-danger/90">
            {e}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The dry-run diff. Rendered before any write, every time. */
function PlanCard({ plan, onImport }: { plan: PlanSummary; onImport: () => void }) {
  const changedDocs = plan.docs.filter((d) => d.action !== "unchanged");
  const changedComps = plan.competitors.filter((c) => c.action !== "unchanged");
  const unchanged =
    plan.docs.length - changedDocs.length + (plan.competitors.length - changedComps.length);

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <Section title="Documents" empty={changedDocs.length === 0 ? "No document changes." : null}>
        {changedDocs.map((d) => (
          <Row
            key={d.label}
            tone={d.action === "create" ? "success" : "info"}
            tag={d.action}
            label={d.label}
            detail={d.detail}
            flag={d.verifyTokens > 0 ? `${d.verifyTokens} [VERIFY]` : null}
          />
        ))}
      </Section>

      <Section title="Competitors" empty={changedComps.length === 0 ? "No competitor changes." : null}>
        {changedComps.map((c) => (
          <Row
            key={c.company}
            tone={c.action === "create" ? "success" : "info"}
            tag={c.action}
            label={c.company}
            detail={c.fields.join(", ")}
          />
        ))}
      </Section>

      <Section
        title="Client profile"
        empty={
          plan.profileFills.length === 0 && plan.brandingFills.length === 0 && !plan.colors
            ? "No profile changes."
            : null
        }
      >
        {plan.profileFills.map((f) => (
          <Row key={f.field} tone="success" tag="fill" label={f.field} detail={f.to} />
        ))}
        {plan.brandingFills.map((f) => (
          <Row key={f} tone="success" tag="fill" label={`brandingGuidelines.${f}`} detail="" />
        ))}
        {plan.colors && (
          <Row
            tone="warning"
            tag="palette"
            label={plan.colors.from.join(" · ") || "(none)"}
            detail={`→ ${plan.colors.to.join(" · ")}`}
          />
        )}
      </Section>

      {plan.skippedProfile.length > 0 && (
        <div className="rounded-md border border-border bg-surface-2 px-3.5 py-2.5">
          <p className="text-xs font-medium text-muted">
            Skipped — a human already set these, and a refresh never overwrites them:
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {plan.skippedProfile.map((s) => (
              <li key={s.field} className="text-[11px] text-muted-2">
                {s.field} — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.seoGeo && <SeoGeoCard seoGeo={plan.seoGeo} />}

      {plan.warnings.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3.5 py-2.5">
          <p className="text-xs font-medium text-warning">
            {plan.warnings.length} warning{plan.warnings.length === 1 ? "" : "s"} — not blocking, but read them:
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {plan.warnings.map((w, i) => (
              <li key={i} className="text-[11px] text-warning/90">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unchanged > 0 && (
        <p className="text-[11px] text-muted-2">
          {unchanged} item{unchanged === 1 ? "" : "s"} in this bundle already match what is stored.
        </p>
      )}

      {plan.lockedReason ? (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-xs text-warning">
          {plan.lockedReason}
        </p>
      ) : plan.counts.totalWrites === 0 ? (
        <p className="text-xs text-muted">Nothing to write — the bundle matches what is already stored.</p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {plan.counts.docWrites} document write{plan.counts.docWrites === 1 ? "" : "s"} ·{" "}
            {plan.counts.compWrites} competitor write{plan.counts.compWrites === 1 ? "" : "s"} ·{" "}
            {plan.counts.clientTouched ? 1 : 0} client update
          </p>
          <Button size="sm" onClick={onImport}>
            <Icon name="Download" className="h-3.5 w-3.5" /> Import
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The SEO/GEO half. Provenance is stated up front because these numbers are
 * normally machine-measured — importing one by hand is the exception, and the
 * page says so rather than letting it blend in with a pipeline capture.
 */
function SeoGeoCard({ seoGeo }: { seoGeo: NonNullable<PlanSummary["seoGeo"]> }) {
  if (!seoGeo.ok) {
    return (
      <div className="rounded-md border border-danger/30 bg-danger/10 px-3.5 py-3">
        <p className="text-xs font-medium text-danger">SEO/GEO snapshot refused — the refresh half can still import.</p>
        <ul className="mt-1.5 space-y-0.5">
          {seoGeo.errors.map((e, i) => (
            <li key={i} className="font-mono text-[11px] text-danger/90">
              {e}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Icon name="Search" className="h-3.5 w-3.5 shrink-0 text-muted" />
        SEO/GEO snapshot · measured {seoGeo.capturedOn}
      </p>
      <p className="mt-1.5 text-[11px] text-muted">Currently stored: {seoGeo.storedProvenance}</p>
      <p className="mt-1 text-[11px] text-muted-2">
        It will be stamped as a hand import, keeping its own capture date and pipeline stamp —
        {seoGeo.willReadAsLegacy
          ? " it renders with the legacy banner, as an unstamped or superseded capture should."
          : " its pipeline stamp is current, so no legacy banner."}
      </p>
      {seoGeo.warnings.map((w, i) => (
        <p key={i} className="mt-1 text-[11px] text-warning">
          {w}
        </p>
      ))}
    </div>
  );
}

function OutcomePanel({ outcome }: { outcome: ApplyOutcome }) {
  const { refresh, seoGeo } = outcome;
  const clean = refresh.applied && !refresh.error && !seoGeo.error;
  return (
    <div
      className={cn(
        "mt-3 rounded-md border px-3.5 py-3",
        clean ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10",
      )}
    >
      <p className={cn("text-sm font-medium", clean ? "text-success" : "text-warning")}>
        {clean ? "Imported" : "Imported with problems"}
      </p>
      <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted">
        <li>
          {refresh.error
            ? `Refresh failed — ${refresh.error}`
            : `${refresh.docs} document(s), ${refresh.competitors} competitor row(s), ${refresh.client} client update.`}
        </li>
        <li>
          {seoGeo.applied
            ? "SEO/GEO snapshot imported and stamped as a hand import."
            : seoGeo.error
              ? `SEO/GEO refused — ${seoGeo.error}`
              : seoGeo.skippedReason
                ? `SEO/GEO skipped — ${seoGeo.skippedReason}`
                : "No SEO/GEO snapshot in this bundle."}
        </li>
      </ul>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">{title}</p>
      {empty ? <p className="text-xs text-muted-2">{empty}</p> : <div className="space-y-1">{children}</div>}
    </div>
  );
}

function Row({
  tone,
  tag,
  label,
  detail,
  flag,
}: {
  tone: "success" | "info" | "warning";
  tag: string;
  label: string;
  detail: string;
  flag?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
      <Badge tone={tone}>{tag}</Badge>
      <span className="text-xs font-medium">{label}</span>
      {detail && <span className="text-[11px] text-muted-2">{detail}</span>}
      {flag && <Badge tone="warning">{flag}</Badge>}
    </div>
  );
}
