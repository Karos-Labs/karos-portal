import "server-only";

import { chargeClientCredits, creditClientCredits } from "@/lib/data";
import { CreditError, isBillableClientActor } from "@/lib/credits";
import type { AppUser, CreditOperation } from "@/lib/types";
import type { ProviderId } from "@/lib/models/usage-log";

/**
 * ONE WAY TO SAY "a client just made us call a model — charge it or refuse it".
 *
 * Every client-triggered model call in this app costs Karos real money the
 * instant it is issued, so each one has to answer the same two questions: does
 * this actor pay, and what happens to their credits if the call then fails.
 * Before this module those two questions were answered five times in four
 * files, in four different spellings:
 *
 *   - `chargeTaskAssist` / `refundTaskAssist`     (actions/task-actions.ts)
 *   - `chargeDocCorrection` / `refundDocCorrection` (actions/intel-actions.ts)
 *   - an inline `isBillableClientActor` + try/catch block (api/clients/[id]/chat)
 *   - `chargeTaskExecution`                       (actions/execution-actions.ts)
 *   - and, at five other client-reachable sites, no answer at all.
 *
 * Two of those spellings threw a `CreditError` on denial and two returned the
 * message; none of them refunded when the model call they had already paid for
 * THREW. That last gap is the one this module exists to close, because it is
 * the only one where a client is billed for a crash.
 *
 * THE PRICE IS NOT DECIDED HERE. Callers pass an `amount` from `CREDIT_COSTS`
 * and name which existing operation class they picked, at their own call site.
 * This module owns the mechanism only: who pays, and the charge/refund pairing.
 *
 * WHAT THIS DOES *NOT* GUARANTEE, stated because the guard is easy to over-read:
 * it makes the refund fire on the failure paths that stay inside `run`. A
 * process death between the charge and the refund is out of reach from here and
 * is owned by the reconciler (`credit-reconcile.ts`), which is why charges that
 * back a durable job should pass a `jobId` — that is the key the sweep pairs on.
 */

/** Everything a charge needs to identify who pays, how much, and for what. */
export interface ClientModelCall {
  /** The session that triggered the call. Staff and View-as-Client never pay. */
  user: Pick<AppUser, "uid" | "name" | "role" | "impersonatedBy">;
  clientId: string;
  /** From `CREDIT_COSTS` — never a literal. See the module note on pricing. */
  amount: number;
  operation: CreditOperation;
  /**
   * Client copy: the ledger feed is rendered ungated to a CLIENT_USER, so this
   * string is read by the person paying. Sentence case, em dash, no lab jargon.
   */
  reason: string;
  /**
   * Set when the charge backs a durable job or task, so the crash reconciler
   * can pair a refund to it later. Omit for calls that finish inside one
   * request — nothing outlives the handler to reconcile.
   */
  jobId?: string | null;
  agentId?: string | null;
  /**
   * The model that actually serves this call, when the caller resolved one
   * before charging — the chat route's per-model chat pricing (T-B23) is the
   * first user. Carried onto the ledger entry / BI event alongside the
   * charge so a client's credit spend can be reconciled against which model
   * ran it, the way `@/lib/models/usage-log.ts`'s `UsageLog.modelName`
   * already does for real-dollar cost. Optional: most call sites price a
   * fixed action rather than a model choice, and pass neither this nor
   * `provider`.
   */
  modelName?: string | null;
  /** Coarse billing family for `modelName` — see `UsageLog.provider`. */
  provider?: ProviderId | null;
}

/**
 * `denied` carries the client-readable refusal when the charge was refused, and
 * is null on every path where the work is allowed to proceed — INCLUDING the
 * free ones (staff, and an admin in View as Client). A caller that treats a
 * successful charge as the precondition for running would lock staff out of
 * their own tooling, so the check is `denied`, never `chargedAt`.
 */
export interface ChargeOutcome {
  denied: string | null;
  /** When the charge landed; null when this actor was not billable. */
  chargedAt: number | null;
}

/**
 * Charge for a client-triggered model call, or report why not.
 *
 * Never throws on a credit denial — the message comes back in `denied` for the
 * caller to return, 402, or rethrow in whatever shape its surface expects.
 * Anything else (a Firestore outage) still throws: that is not a refusal, and
 * silently letting the call through would be a free model run.
 */
export async function chargeClientModelCall(call: ClientModelCall): Promise<ChargeOutcome> {
  if (!isBillableClientActor(call.user)) return { denied: null, chargedAt: null };
  const chargedAt = Date.now();
  try {
    await chargeClientCredits({
      clientId: call.clientId,
      amount: call.amount,
      operation: call.operation,
      reason: call.reason,
      jobId: call.jobId ?? null,
      agentId: call.agentId ?? null,
      modelName: call.modelName ?? null,
      provider: call.provider ?? null,
      actorUid: call.user.uid,
      actorName: call.user.name,
    });
    return { denied: null, chargedAt };
  } catch (e) {
    if (e instanceof CreditError) return { denied: e.message, chargedAt: null };
    throw e;
  }
}

/**
 * Hand a charge back. A no-op when `chargedAt` is null (nothing was charged),
 * and NEVER throws: a refund failing must not turn an already-failed run into a
 * second, different error for the client. A refund lost this way is picked up
 * by the reconciler when the charge carried a `jobId`, and logged either way.
 */
export async function refundClientModelCall(
  call: ClientModelCall,
  chargedAt: number | null,
  reason: string,
): Promise<void> {
  if (chargedAt == null) return;
  try {
    await creditClientCredits({
      clientId: call.clientId,
      amount: call.amount,
      kind: "refund",
      chargedAt,
      operation: call.operation,
      reason,
      jobId: call.jobId ?? null,
      agentId: call.agentId ?? null,
      modelName: call.modelName ?? null,
      provider: call.provider ?? null,
      actorUid: call.user.uid,
      actorName: call.user.name,
    });
  } catch (e) {
    console.error("[client-model-charge] refund failed:", e);
  }
}

/**
 * A ONCE-ONLY refund handle for a charge taken with `chargeClientModelCall` —
 * the manual half of `withClientModelCharge`, with the same contract its `ctx.refund`
 * has, and for the same reason: refunding twice is a worse bug than the one the
 * refund was added for.
 *
 * `refundClientModelCall` itself cannot carry the guard. It is a plain function
 * over its arguments, and `creditClientCredits` has no idempotency key, so two
 * calls write two credit rows. The guard has to live in something the caller
 * holds for the length of one run — this.
 *
 * The live case is a streaming handler: the AI SDK's `onError` is invoked once
 * per `error` part, not once per call, so a stream that emits two error parts
 * called the naked refund twice and paid the client twice for one charge.
 */
export function refundOnce(
  call: ClientModelCall,
  chargedAt: number | null,
): (reason: string) => Promise<void> {
  let done = false;
  return async (reason: string) => {
    if (done) return;
    done = true;
    await refundClientModelCall(call, chargedAt, reason);
  };
}

/**
 * Discriminated on `ok`, not on the truthiness of `denied`: a denial message is
 * a `string`, and TypeScript cannot narrow a `string` member away by
 * truthiness, so `if (outcome.denied)` left `result` possibly-undefined at
 * every call site. `ok` makes the refused branch impossible to read past.
 */
export type ChargedRun<T> = { ok: false; denied: string } | { ok: true; result: T };

/**
 * Charge, run the model call, and hand the credits back if it fails.
 *
 * THE REASON THIS WRAPPER EXISTS rather than a charge helper the caller pairs
 * by hand: every site that paired by hand got the same case wrong. Each one
 * refunded when the model came back with nothing USEFUL — an unchanged
 * document, a duplicate task — and none refunded when the model call THREW, so
 * a timeout or a provider 500 left the client paying for a crash. Pairing the
 * refund to the `try` rather than to the caller's discipline is what closes it.
 *
 * `run` receives `refund` for the other half: the call SUCCEEDED but produced
 * nothing the client can use. That case cannot be detected from out here — only
 * the caller knows what "nothing" means for its own output — so it stays the
 * caller's judgement, while the crash path stops being anybody's judgement.
 *
 * `refund` is idempotent within one run: calling it and then throwing refunds
 * once, not twice. Deliberate, because "refund, then fail while cleaning up" is
 * a real path and double-refunding a client is a worse bug than the one fixed.
 */
export async function withClientModelCharge<T>(
  call: ClientModelCall,
  run: (ctx: { refund: (reason: string) => Promise<void> }) => Promise<T>,
): Promise<ChargedRun<T>> {
  const { denied, chargedAt } = await chargeClientModelCall(call);
  if (denied !== null) return { ok: false, denied };

  let refunded = false;
  const refund = async (reason: string) => {
    if (refunded) return;
    refunded = true;
    await refundClientModelCall(call, chargedAt, reason);
  };

  try {
    return { ok: true, result: await run({ refund }) };
  } catch (e) {
    // The client is not paying for our crash. Rethrown unchanged afterwards so
    // the caller's own error handling — logging, taxonomy, the message it shows
    // — is untouched by the refund happening.
    await refund(refundReasonFor(call.reason));
    throw e;
  }
}

/**
 * The ledger line a client sees when a paid-for run failed outright.
 *
 * Built from the charge's own reason so the refund row names the same thing the
 * charge row did, and truncated to the same 120 the webhook's refunds use, so a
 * long asset title cannot produce a ledger row that renders as a wall of text.
 */
export function refundReasonFor(chargeReason: string): string {
  return `Refund · run failed · ${chargeReason}`.slice(0, 120);
}
