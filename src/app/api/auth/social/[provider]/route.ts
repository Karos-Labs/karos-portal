import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import {
  OAUTH_CONFIGS,
  signOAuthState,
  buildCallbackUrl,
  generateCodeVerifier,
  generateCodeChallenge,
} from "@/lib/integrations/oauth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const clientId = req.nextUrl.searchParams.get("clientId");

  const user = await getCurrentUser();
  if (!user || user.disabled)
    return new Response("Unauthorized", { status: 401 });
  if (!clientId)
    return new Response("Missing clientId", { status: 400 });
  if (user.role === "CLIENT_USER" && user.clientId !== clientId)
    return new Response("Forbidden", { status: 403 });

  const config = OAUTH_CONFIGS[provider];
  if (!config)
    return new Response("Unknown provider", { status: 404 });

  const appClientId = process.env[config.envClientId];
  const appClientSecret = process.env[config.envClientSecret];
  if (!appClientId || !appClientSecret)
    return new Response("OAuth not configured for this provider", { status: 503 });

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
    client_id: appClientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
  });

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
