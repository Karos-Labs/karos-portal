import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listEmployeeSeats } from "@/lib/data";
import {
  OAUTH_CONFIGS,
  isOAuthEnabled,
  signOAuthState,
  buildEmployeeCallbackUrl,
} from "@/lib/integrations/oauth";

/**
 * "Sign in with LinkedIn" for one employee-advocacy seat. Signs a state token
 * carrying the target seatId and redirects to LinkedIn's OAuth consent. The
 * callback exchanges the code and attaches the encrypted tokens to that seat —
 * so multiple distinct employee handles connect independently under one client.
 *
 * Auth: staff, or the client's own user. GET (browser navigation).
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const clientId = url.searchParams.get("clientId");
  const seatId = url.searchParams.get("seatId");
  if (!clientId || !seatId) {
    return NextResponse.json({ error: "clientId and seatId are required" }, { status: 400 });
  }

  const isStaff = user.role === "KAROS_ADMIN" || user.role === "KAROS_EMPLOYEE";
  if (!isStaff && !(user.role === "CLIENT_USER" && user.clientId === clientId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
  const state = signOAuthState({ clientId, uid: user.uid, provider: "linkedin", seatId });

  const authUrl = new URL(cfg.authUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", process.env[cfg.envClientId] ?? "");
  authUrl.searchParams.set("redirect_uri", buildEmployeeCallbackUrl());
  authUrl.searchParams.set("scope", cfg.scopes.join(" "));
  authUrl.searchParams.set("state", state);

  return NextResponse.redirect(authUrl.toString());
}
