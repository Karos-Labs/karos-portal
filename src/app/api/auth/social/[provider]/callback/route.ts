import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { upsertClientIntegration } from "@/lib/data";
import { autoCompleteTasksOnIntegrationConnect } from "@/lib/task-sync";
import {
  OAUTH_CONFIGS,
  verifyOAuthState,
  buildCallbackUrl,
  getAppOrigin,
} from "@/lib/integrations/oauth";

/* ── HTML page helpers ───────────────────────────────────────────────── */

const BASE_STYLE = `*{box-sizing:border-box;margin:0;padding:0}body{background:#07090b;color:#e5e7eb;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{text-align:center;padding:2rem;max-width:320px}.icon{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.25rem}h2{font-size:1.125rem;font-weight:600;margin-bottom:.5rem;color:#fff}p{color:#6b7280;font-size:.875rem;line-height:1.5}`;

function htmlPage(body: string, script: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Karos CMO</title><style>${BASE_STYLE}</style></head><body><div class="card">${body}</div><script>${script}<\/script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function successPage(platform: string, accountName: string, origin: string): Response {
  const body = `<div class="icon" style="background:#FF6B2C22"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#FF6B2C" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div><h2>Connected!</h2><p>Closing window…</p>`;
  const script = `(function(){var o=window.opener;if(o&&!o.closed){o.postMessage({type:"karos_oauth_success",platform:${JSON.stringify(platform)},accountName:${JSON.stringify(accountName)}},${JSON.stringify(origin)});setTimeout(function(){window.close()},800)}else{document.querySelector("p").textContent="You can close this window."}})()`;
  return htmlPage(body, script);
}

function errorPage(platform: string, message: string, origin: string): Response {
  const body = `<div class="icon" style="background:#ef444422"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/></svg></div><h2>Connection failed</h2><p>${esc(message)}</p>`;
  const script = `(function(){var o=window.opener;if(o&&!o.closed){o.postMessage({type:"karos_oauth_error",platform:${JSON.stringify(platform)},error:${JSON.stringify(message)}},${JSON.stringify(origin)});setTimeout(function(){window.close()},1500)}else{document.querySelector("p").textContent+=" You can close this window."}})()`;
  return htmlPage(body, script);
}

/* ── Token exchange ──────────────────────────────────────────────────── */

async function exchangeCode(
  provider: string,
  code: string,
  redirectUri: string,
  codeVerifier: string | null,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const config = OAUTH_CONFIGS[provider]!;
  const appClientId = process.env[config.envClientId]!;
  const appClientSecret = process.env[config.envClientSecret]!;

  if (provider === "twitter") {
    const basicAuth = Buffer.from(`${appClientId}:${appClientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    if (codeVerifier) body.set("code_verifier", codeVerifier);
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
    const data = (await res.json()) as { access_token: string; refresh_token?: string };
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  }

  if (provider === "linkedin") {
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: appClientId,
        client_secret: appClientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
    const data = (await res.json()) as { access_token: string; refresh_token?: string };
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  }

  if (provider === "facebook" || provider === "instagram") {
    // Step 1 — short-lived token
    const shortUrl = new URL(config.tokenUrl);
    shortUrl.searchParams.set("client_id", appClientId);
    shortUrl.searchParams.set("client_secret", appClientSecret);
    shortUrl.searchParams.set("redirect_uri", redirectUri);
    shortUrl.searchParams.set("code", code);
    const shortRes = await fetch(shortUrl.toString());
    if (!shortRes.ok) throw new Error(`Token exchange failed (${shortRes.status})`);
    const short = (await shortRes.json()) as { access_token: string };

    // Step 2 — long-lived token (60 days)
    const longUrl = new URL(config.tokenUrl);
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", appClientId);
    longUrl.searchParams.set("client_secret", appClientSecret);
    longUrl.searchParams.set("fb_exchange_token", short.access_token);
    const longRes = await fetch(longUrl.toString());
    if (!longRes.ok) throw new Error(`Long-lived token exchange failed (${longRes.status})`);
    const long = (await longRes.json()) as { access_token: string };
    return { accessToken: long.access_token };
  }

  if (provider === "youtube") {
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: appClientId,
        client_secret: appClientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
    const data = (await res.json()) as { access_token: string; refresh_token?: string };
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  }

  if (provider === "tiktok") {
    // TikTok v2: credential is `client_key`, PKCE code_verifier is required, and
    // the response is a flat JSON object (access_token + refresh_token at top level).
    const body = new URLSearchParams({
      client_key: appClientId,
      client_secret: appClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    if (codeVerifier) body.set("code_verifier", codeVerifier);
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
      body,
    });
    if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!data.access_token) {
      throw new Error(data.error_description ?? data.error ?? "Token exchange failed");
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

/* ── Account name (best-effort) ──────────────────────────────────────── */

async function fetchAccountName(provider: string, accessToken: string): Promise<string> {
  try {
    if (provider === "linkedin") {
      const res = await fetch(
        "https://api.linkedin.com/v2/me?projection=(localizedFirstName,localizedLastName)",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (res.ok) {
        const d = (await res.json()) as { localizedFirstName?: string; localizedLastName?: string };
        return `${d.localizedFirstName ?? ""} ${d.localizedLastName ?? ""}`.trim();
      }
    }
    if (provider === "facebook" || provider === "instagram") {
      const res = await fetch(
        `https://graph.facebook.com/me?fields=name&access_token=${accessToken}`,
      );
      if (res.ok) {
        const d = (await res.json()) as { name?: string };
        return d.name ?? "";
      }
    }
    if (provider === "twitter") {
      const res = await fetch("https://api.twitter.com/2/users/me?user.fields=username,name", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const d = (await res.json()) as { data?: { username?: string; name?: string } };
        return d.data?.username ? `@${d.data.username}` : (d.data?.name ?? "");
      }
    }
    if (provider === "youtube") {
      const res = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (res.ok) {
        const d = (await res.json()) as { items?: Array<{ snippet?: { title?: string } }> };
        return d.items?.[0]?.snippet?.title ?? "";
      }
    }
    if (provider === "tiktok") {
      const res = await fetch(
        "https://open.tiktokapis.com/v2/user/info/?fields=display_name",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (res.ok) {
        const d = (await res.json()) as { data?: { user?: { display_name?: string } } };
        const name = d.data?.user?.display_name;
        return name ? `@${name}` : "";
      }
    }
  } catch {
    // Best-effort — don't block the callback
  }
  return "";
}

/* ── Callback handler ────────────────────────────────────────────────── */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const origin = getAppOrigin();
  const sp = req.nextUrl.searchParams;
  const code = sp.get("code");
  const state = sp.get("state");
  const oauthError = sp.get("error");
  const oauthErrorDesc = sp.get("error_description");

  if (oauthError) {
    return errorPage(provider, oauthErrorDesc ?? oauthError, origin);
  }
  if (!code || !state) {
    return errorPage(provider, "Invalid callback — missing code or state.", origin);
  }

  // Verify state against the cookie value (CSRF check)
  const cookieStore = await cookies();
  const savedState = cookieStore.get("karos_oauth_state")?.value;
  if (!savedState || savedState !== state) {
    return errorPage(provider, "State mismatch — please try connecting again.", origin);
  }
  cookieStore.delete("karos_oauth_state");

  const parsed = verifyOAuthState(state);
  if (!parsed || parsed.provider !== provider) {
    return errorPage(provider, "Invalid state signature.", origin);
  }

  const config = OAUTH_CONFIGS[provider];
  if (!config) return errorPage(provider, "Unknown provider.", origin);

  // Retrieve PKCE verifier if needed
  let codeVerifier: string | null = null;
  if (config.usePkce) {
    codeVerifier = cookieStore.get("karos_oauth_pkce")?.value ?? null;
    cookieStore.delete("karos_oauth_pkce");
    if (!codeVerifier) {
      return errorPage(provider, "PKCE verifier missing — please try again.", origin);
    }
  }

  try {
    const redirectUri = buildCallbackUrl(provider);
    const { accessToken, refreshToken } = await exchangeCode(
      provider,
      code,
      redirectUri,
      codeVerifier,
    );

    const accountName = await fetchAccountName(provider, accessToken);

    const credentials: Record<string, string> = { accessToken };
    if (refreshToken) credentials.refreshToken = refreshToken;

    await upsertClientIntegration({
      clientId: parsed.clientId,
      platform: provider,
      credentials,
      accountName: accountName || undefined,
      method: "oauth",
      // Set status explicitly: consumers that filter `status === "active"`
      // (analytics, copilot context, proactive assistant) drop status-less
      // integrations, so a freshly-connected OAuth channel must be marked active
      // — mirroring saveGoogleOAuthTokenAction.
      status: "active",
      connectedBy: parsed.uid,
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Task Map sync: the client just did this work — flip any matching
    // "Connect <platform>" onboarding task to Done automatically.
    await autoCompleteTasksOnIntegrationConnect(parsed.clientId, provider).catch(() => {});

    return successPage(provider, accountName, origin);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Connection failed — please try again.";
    return errorPage(provider, message, origin);
  }
}
