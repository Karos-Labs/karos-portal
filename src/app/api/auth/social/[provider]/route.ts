import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import {
  OAUTH_CONFIGS,
  signOAuthState,
  buildCallbackUrl,
  generateCodeVerifier,
  generateCodeChallenge,
  getRequestedScopes,
  getAppOrigin,
} from "@/lib/integrations/oauth";
import { errorPage } from "@/lib/integrations/oauth-popup";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const clientId = req.nextUrl.searchParams.get("clientId");
  // This route is loaded inside the connect popup, so every refusal must be the
  // same postMessage shell the callback uses — a bare text body left the card
  // behind it stuck on "Connecting…" with the reason trapped in the popup
  // (QA F55). Messages are client-readable: no env-var names, no "Forbidden".
  const origin = getAppOrigin();

  const user = await getCurrentUser();
  if (!user || user.disabled)
    return errorPage(provider, "Your session expired — sign in again and retry.", origin, 401);
  if (!clientId)
    return errorPage(provider, "We couldn't tell which workspace to connect. Reload and retry.", origin, 400);
  if (user.role === "CLIENT_USER" && user.clientId !== clientId)
    return errorPage(provider, "This account can't connect channels for that workspace.", origin, 403);

  const config = OAUTH_CONFIGS[provider];
  if (!config)
    return errorPage(provider, "This channel isn't connectable from the portal yet.", origin, 404);

  const appClientId = process.env[config.envClientId];
  const appClientSecret = process.env[config.envClientSecret];
  if (!appClientId || !appClientSecret)
    return errorPage(
      provider,
      "This channel isn't connectable yet — your Karos team still has to finish setting it up.",
      origin,
      503,
    );

  const state = signOAuthState({ clientId, uid: user.uid, provider });
  const isProduction = process.env.NODE_ENV === "production";

  const cookieStore = await cookies();
  cookieStore.set("karos_oauth_state", state, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/auth/social",
  });

  const redirectUri = buildCallbackUrl(provider);
  const authParams = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    scope: getRequestedScopes(provider).join(config.scopeSeparator ?? " "),
    state,
  });
  // Most providers use "client_id"; TikTok uses "client_key" (config-driven).
  authParams.set(config.clientIdParam ?? "client_id", appClientId);

  for (const [k, v] of Object.entries(config.extraAuthParams ?? {})) {
    authParams.set(k, v);
  }

  if (config.usePkce) {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    cookieStore.set("karos_oauth_pkce", verifier, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 600,
      path: "/api/auth/social",
    });
    authParams.set("code_challenge", challenge);
    authParams.set("code_challenge_method", "S256");
  }

  return NextResponse.redirect(`${config.authUrl}?${authParams}`);
}
