import { cookies } from "next/headers";
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

  // THE STATE ALSO GOES IN A COOKIE, so the callback can tell "the browser that
  // started this flow came back" from "someone replayed a state they saw".
  //
  // The signature alone proves the token was minted here; it does not prove WHO
  // is presenting it, and the token travels in a URL — browser history, the
  // Referer header, proxy and provider logs, a shared screen. Within its
  // ten-minute life anyone holding it could complete the flow with their OWN
  // LinkedIn authorization code, and the callback would write THEIR access
  // token onto this client's seat, after which the portal posts as them.
  //
  // This is the binding the social-connect flow has always had
  // (`/api/auth/social/[provider]` sets the same cookie and its callback
  // requires an exact match); the employee flow shipped without it. Same name,
  // same options, different `path` — scoped to the route that reads it, so the
  // two flows cannot consume each other's cookie.
  const cookieStore = await cookies();
  cookieStore.set("karos_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/api/integrations/linkedin/employee",
  });

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
