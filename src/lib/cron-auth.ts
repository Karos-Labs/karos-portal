import "server-only";
import { NextResponse } from "next/server";

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
  if (opts.provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/** Convenience for the `Authorization: Bearer <CRON_SECRET>` pattern used by the cron routes. */
export function requireCronSecret(req: Request, envVar = "CRON_SECRET"): NextResponse | null {
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  return checkWebhookSecret({ envVar, provided });
}
