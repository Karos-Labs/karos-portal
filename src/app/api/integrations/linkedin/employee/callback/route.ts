import { NextResponse, type NextRequest } from "next/server";
import { updateEmployeeSeat } from "@/lib/data";
import {
  OAUTH_CONFIGS,
  verifyOAuthState,
  buildEmployeeCallbackUrl,
  getAppOrigin,
} from "@/lib/integrations/oauth";
import { logger } from "@/services/logger";

/**
 * LinkedIn employee-advocacy OAuth callback. Verifies the signed state (which
 * carries the target seatId + clientId), exchanges the authorization code for
 * access/refresh tokens, and writes them — ENCRYPTED via updateEmployeeSeat —
 * onto that employee's seat, marking it active. Redirects back to the client's
 * settings with a status flag.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const origin = getAppOrigin();
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const verified = state ? verifyOAuthState(state) : null;
  // Without a valid state we don't trust any clientId in the URL — bounce home.
  if (!verified || verified.provider !== "linkedin" || !verified.seatId) {
    return NextResponse.redirect(`${origin}/dashboard?linkedin_seat=invalid_state`);
  }
  const { clientId, seatId } = verified;
  const settingsUrl = `${origin}/clients/${clientId}/settings`;

  if (oauthError || !code) {
    return NextResponse.redirect(`${settingsUrl}?linkedin_seat=denied`);
  }

  const cfg = OAUTH_CONFIGS.linkedin;
  const clientKey = process.env[cfg.envClientId];
  const clientSecret = process.env[cfg.envClientSecret];
  if (!clientKey || !clientSecret) {
    return NextResponse.redirect(`${settingsUrl}?linkedin_seat=not_configured`);
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: buildEmployeeCallbackUrl(),
      client_id: clientKey,
      client_secret: clientSecret,
    });
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`token exchange failed (${res.status}) ${detail.slice(0, 200)}`);
    }
    const token = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!token.access_token) throw new Error("no access_token in LinkedIn response");

    // updateEmployeeSeat encrypts credentials at rest (token-cipher, AES-256-GCM).
    await updateEmployeeSeat(clientId, seatId, {
      status: "active",
      credentials: {
        accessToken: token.access_token,
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      },
    });

    return NextResponse.redirect(`${settingsUrl}?linkedin_seat=connected`);
  } catch (e) {
    logger.logError({
      clientId,
      agentId: null,
      operation: "linkedin_employee_oauth",
      errorMessage: `Employee seat ${seatId} OAuth failed: ${e instanceof Error ? e.message : "unknown"}`,
      severity: "ERROR",
    });
    return NextResponse.redirect(`${settingsUrl}?linkedin_seat=error`);
  }
}
