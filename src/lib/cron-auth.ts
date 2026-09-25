import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { OAuth2Client } from "google-auth-library";
import { appLinkBase } from "@/lib/app-origin";

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
 * The service accounts whose Google-signed OIDC token may call a cron route
 * (SCRUM-513). Whitespace- or comma-separated, compared case-insensitively.
 * Empty means OIDC is off and only the shared secret is accepted, which is
 * exactly the behaviour before this existed.
 */
function oidcServiceAccounts(): string[] {
  return (process.env.CRON_OIDC_SERVICE_ACCOUNTS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * The audiences a cron token may carry: `CRON_OIDC_AUDIENCE` when set, else the
 * app's own origin (`appLinkBase()`, i.e. APP_URL). A token whose audience is that origin, or any
 * `/api/...` URL under it (Cloud Scheduler's default audience is the full
 * target URL), is accepted. Anything else is a token minted for someone else.
 */
function oidcAudienceAccepts(aud: string | string[] | undefined): boolean {
  const base = (process.env.CRON_OIDC_AUDIENCE?.trim() || appLinkBase()).replace(/\/+$/, "");
  if (!base) return false;
  const auds = Array.isArray(aud) ? aud : aud ? [aud] : [];
  return auds.some((a) => {
    const v = a.replace(/\/+$/, "");
    return v === base || v.startsWith(`${base}/api/`);
  });
}

function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

let oidcClient: OAuth2Client | undefined;

/** Verifies a Google-signed ID token and returns its caller's email, or `undefined` for anything that does not verify. */
async function verifiedOidcEmail(token: string): Promise<string | undefined> {
  oidcClient ??= new OAuth2Client();
  try {
    // Audience is checked below rather than here, so the default full-URL
    // audience Cloud Scheduler mints can be accepted under the app's origin.
    const ticket = await oidcClient.verifyIdToken({ idToken: token });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified !== true) return undefined;
    if (!oidcAudienceAccepts(payload.aud)) return undefined;
    return payload.email.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Cron auth for GCP Cloud Scheduler. Accepts, in this order:
 *
 * 1. **A Google-signed OIDC token** (`Authorization: Bearer <id token>`) from a
 *    service account listed in `CRON_OIDC_SERVICE_ACCOUNTS`, with an audience
 *    under the app's origin (SCRUM-513). This is what Cloud Scheduler sends
 *    when a job is configured with `--oidc-service-account-email`, and nobody
 *    who can read the job's configuration can reuse it: the token is minted
 *    per request, expires within the hour, and is bound to the audience.
 * 2. **The shared secret**, via `Authorization: Bearer <CRON_SECRET>` or an
 *    `X-Cron-Secret` header, so jobs still configured the old way keep working
 *    while they are moved. Fails closed in production when the secret is unset
 *    (checkWebhookSecret).
 *
 * A bearer that looks like a JWT while OIDC is configured is judged as a token
 * and never compared to the secret: a failed token is a 401, not a second try.
 *
 * We intentionally do NOT trust `X-CloudScheduler*` marker headers on their own:
 * they're set by the scheduler but any caller can forge them.
 *
 * ASYNC since SCRUM-513, because verifying a token fetches Google's signing
 * keys (cached by the client). Every caller awaits it.
 */
export async function requireCronSecret(req: Request, envVar = "CRON_SECRET"): Promise<NextResponse | null> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null;

  const accounts = oidcServiceAccounts();
  if (bearer && accounts.length > 0 && looksLikeJwt(bearer)) {
    const email = await verifiedOidcEmail(bearer);
    if (email && accounts.includes(email)) return null;
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const headerSecret = req.headers.get("x-cron-secret");
  const provided = bearer ?? headerSecret ?? null;
  return checkWebhookSecret({ envVar, provided });
}
