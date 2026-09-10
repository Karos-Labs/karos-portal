import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

/** Constant-time string equality — avoids leaking secret length/prefix via response timing. */
function secretsMatch(provided: string, secret: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on a length mismatch, so unequal-length secrets never match
  // (and never differ in HOW they fail — both return false, no early throw to time).
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Shared bearer/secret gate for cron and inbound-webhook endpoints.
 *
 * Previously each route inlined `const secret = process.env.X; if (secret) { …check… }`,
 * which **fails open**: whenever the env var was unset the check was skipped entirely and
 * the (state-mutating) endpoint became fully public. This helper **fails closed in
 * production** — a missing secret returns 503 instead of allowing the request — while
 * preserving the dev convenience of running cron routes locally without a secret set.
 *
 * Pass the secret value the caller actually presented (`provided`); returns a NextResponse
 * to short-circuit on failure, or `null` when the request is authorized and may proceed.
 */
export function checkWebhookSecret(opts: {
  envVar: string;
  provided: string | null;
}): NextResponse | null {
  const secret = process.env[opts.envVar];
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: `${opts.envVar} is not configured` }, { status: 503 });
    }
    return null; // dev: no secret configured ⇒ allow local invocation
  }
  if (!opts.provided || !secretsMatch(opts.provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * Cron auth for GCP Cloud Scheduler. Accepts the shared secret via either the
 * `Authorization: Bearer <CRON_SECRET>` header (the convention our Cloud
 * Scheduler jobs use — see agent-service/DEPLOY.md) or an `X-Cron-Secret`
 * header, so scheduler jobs configured either way authenticate. Fails closed in
 * production when the secret is unset (checkWebhookSecret).
 *
 * We intentionally do NOT trust `X-CloudScheduler*` marker headers on their own:
 * they're set by the scheduler but any caller can forge them, so the secret is
 * always required. Their presence is only used to prefer the header-secret path.
 */
export function requireCronSecret(req: Request, envVar = "CRON_SECRET"): NextResponse | null {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  const headerSecret = req.headers.get("x-cron-secret");
  const provided = bearer ?? headerSecret ?? null;
  return checkWebhookSecret({ envVar, provided });
}
