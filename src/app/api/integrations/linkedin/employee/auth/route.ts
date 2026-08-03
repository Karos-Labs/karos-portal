import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canViewClient } from "@/lib/client-visibility";
import { getClient, listEmployeeSeats } from "@/lib/data";
import {
  OAUTH_CONFIGS,
  isOAuthEnabled,
  signOAuthState,
  buildEmployeeCallbackUrl,
  getRequestedScopes,
} from "@/lib/integrations/oauth";

/**
 * "Sign in with LinkedIn" for one employee-advocacy seat. Signs a state token
 * carrying the target seatId and redirects to LinkedIn's OAuth consent. The
 * callback exchanges the code and attaches the encrypted tokens to that seat —
 * so multiple distinct employee handles connect independently under one client.
 *
 * Auth: staff assigned to this client, or the client's own user. GET (browser
 * navigation).
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const clientId = url.searchParams.get("clientId");
  const seatId = url.searchParams.get("seatId");
  const returnToParam = url.searchParams.get("returnTo");
  const returnTo = returnToParam === "onboarding" ? "onboarding" : undefined;
  if (!clientId || !seatId) {
    return NextResponse.json({ error: "clientId and seatId are required" }, { status: 400 });
  }

  // Staff are scoped to their assigned clients, not admitted by role alone:
  // `signOAuthState` below binds `clientId` into the token the callback trusts,
  // so an unfenced employee could attach a real LinkedIn identity to a seat on
  // a client they were never assigned. The client's own user stays pinned to
  // their own workspace as before.
  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  const client = await getClient(clientId);
  const permitted = isStaff
    ? !!client && canViewClient(user, client)
    : user.role === "CLIENT_USER" && user.clientId === clientId && !!client;
  if (!permitted) {
    // The shape a missing seat already answers with, so a refusal says nothing
    // about whether this client or this seat exists.
    return NextResponse.json({ error: "Employee seat not found" }, { status: 404 });
  }

  if (!isOAuthEnabled("linkedin")) {
    return NextResponse.json(
      { error: "LinkedIn OAuth is not configured (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET)." },
      { status: 503 },
    );
  }

  // The seat must exist before it can be connected.
  const seats = await listEmployeeSeats(clientId);
  if (!seats.some((s) => s.id === seatId)) {
    return NextResponse.json({ error: "Employee seat not found" }, { status: 404 });
  }

  const cfg = OAUTH_CONFIGS.linkedin;
  const state = signOAuthState({ clientId, uid: user.uid, provider: "linkedin", seatId, returnTo });

  const authUrl = new URL(cfg.authUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", process.env[cfg.envClientId] ?? "");
  authUrl.searchParams.set("redirect_uri", buildEmployeeCallbackUrl());
  // getRequestedScopes, not cfg.scopes — reading `.scopes` directly bypasses the
  // extendedScopes approval gate, so this flow would keep requesting an
  // unapproved scope (and get the whole authorize request rejected) after a
  // future edit adds one to the linkedin config. No behaviour change today:
  // linkedin has no extendedScopes, so both resolve to the same four scopes.
  authUrl.searchParams.set("scope", getRequestedScopes("linkedin").join(" "));
  authUrl.searchParams.set("state", state);

  return NextResponse.redirect(authUrl.toString());
}
