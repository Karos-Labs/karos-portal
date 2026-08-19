import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { upsertClientIntegration } from "@/lib/data";
import { autoCompleteTasksOnIntegrationConnect } from "@/lib/task-sync";
import {
  OAUTH_CONFIGS,
  verifyOAuthState,
  buildCallbackUrl,
  getAppOrigin,
  getRequestedScopes,
} from "@/lib/integrations/oauth";
import { GOOGLE_UNIFIED_SUB_PLATFORM_IDS } from "@/lib/integrations/platforms";
import {
  errorPage,
  successPage,
  OAUTH_UNSUPPORTED_CHANNEL_MESSAGE,
} from "@/lib/integrations/oauth-popup";

/* ── Token exchange ──────────────────────────────────────────────────── */

async function exchangeCode(
  provider: string,
  code: string,
  redirectUri: string,
  codeVerifier: string | null,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const config = OAUTH_CONFIGS[provider]!;
  const appClientId = process.env[config.envClientId];
  if (!appClientId) throw new Error(`${config.envClientId} is not configured`);
  const appClientSecret = process.env[config.envClientSecret];
  if (!appClientSecret) throw new Error(`${config.envClientSecret} is not configured`);

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

  if (provider === "linkedin" || provider === "linkedin_community") {
    // Same token endpoint/grant for both — the ONLY difference between the
    // primary app and the Community Management app is which client_id/secret
    // pair `config` resolves to (see OAUTH_CONFIGS in oauth.ts). They are two
    // separate LinkedIn Developer apps because LinkedIn rejects an app that
    // mixes the Community Management API product with Sign In/Share.
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

  if (
    provider === "youtube" ||
    provider === "google_search_console" ||
    provider === "google_analytics" ||
    provider === "google_business_profile" ||
    provider === "google_unified"
  ) {
    // All five share one Google Cloud OAuth client (GOOGLE_CLIENT_ID/SECRET) —
    // only the requested scope differs per provider (see oauth.ts).
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

  if (provider === "reddit") {
    // Reddit requires HTTP Basic auth with the app credentials (like Twitter).
    const basicAuth = Buffer.from(`${appClientId}:${appClientSecret}`).toString("base64");
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Reddit requires a descriptive, non-generic User-Agent on every call.
        "User-Agent": "karoscmo:agent-connectors:v1 (by /u/karoslabs)",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
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
    if (provider === "linkedin_community") {
      // No /v2/me here — an org-scoped token (r_organization_social/admin) has
      // no profile/openid scope, so this call would just 403. There's also no
      // single "the organization" for this token until the admin tells us
      // which one via the Organization URN field, so leave the label blank
      // rather than guessing.
      return "";
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
    if (provider === "reddit") {
      const res = await fetch("https://oauth.reddit.com/api/v1/me", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "karoscmo:agent-connectors:v1 (by /u/karoslabs)",
        },
      });
      if (res.ok) {
        const d = (await res.json()) as { name?: string };
        return d.name ? `u/${d.name}` : "";
      }
    }
    if (provider === "google_search_console") {
      const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const d = (await res.json()) as { siteEntry?: Array<{ siteUrl?: string }> };
        return d.siteEntry?.[0]?.siteUrl ?? "";
      }
    }
    if (provider === "google_analytics" || provider === "google_business_profile") {
      // Both need a client-picked property/location id (there's no single "the
      // property" for a Google account) — captured in a follow-up settings step
      // rather than guessed here from the token alone.
      return "";
    }
    if (provider === "google_unified") {
      // openid/userinfo.email were added to this flow's scopes specifically so
      // we have something human-readable to show across all four sub-services.
      const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const d = (await res.json()) as { email?: string };
        return d.email ?? "";
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

  // EVERY MESSAGE BELOW IS CLIENT COPY, and it did not read as any. This handler
  // answers with the popup shell (oauth-popup.ts), which renders the message as
  // HTML in the window a client opened from "Add a channel" and posts it to the
  // card behind it — so these are read by the person connecting, not by a fetch
  // caller. They shipped as protocol notes: four carried the spaced hyphen the
  // client copy rules ban ("Invalid callback - missing code or state.") and the
  // words were the flow's internals rather than anything the reader can act on —
  // "State mismatch", "Invalid state signature", "PKCE verifier missing",
  // "Unknown provider". The sibling authorize route already wrote em dashes and
  // plain sentences, so the two halves of one popup disagreed.
  //
  // None of them names a parameter, a cookie or a protocol step. The ones written
  // here as sentences end in what the reader can do, because their causes (a
  // redirect that came back incomplete, a cookie that expired or was blocked, a
  // signature that does not verify, a verifier this browser no longer has) are all
  // the same thing to a client and the honest answer to each is to start the
  // connection again. OAUTH_UNSUPPORTED_CHANNEL_MESSAGE is the exception and offers
  // no next step ON PURPOSE — there is none to offer, the portal cannot connect
  // that channel at all — which is also why it is asked for from oauth-popup.ts
  // instead of being spelled here and in the authorize route separately.
  if (oauthError) {
    return errorPage(provider, oauthErrorDesc ?? oauthError, origin);
  }
  if (!code || !state) {
    return errorPage(provider, "That channel didn't send back everything we needed — start the connection again.", origin);
  }

  // Verify state against the cookie value (CSRF check)
  const cookieStore = await cookies();
  const savedState = cookieStore.get("karos_oauth_state")?.value;
  if (!savedState || savedState !== state) {
    return errorPage(provider, "We couldn't match this window to the connection you started — start it again.", origin);
  }
  cookieStore.delete("karos_oauth_state");

  const parsed = verifyOAuthState(state);
  if (!parsed || parsed.provider !== provider) {
    return errorPage(provider, "We couldn't verify where this connection came back from — start it again.", origin);
  }

  const config = OAUTH_CONFIGS[provider];
  if (!config) return errorPage(provider, OAUTH_UNSUPPORTED_CHANNEL_MESSAGE, origin);

  // Retrieve PKCE verifier if needed
  let codeVerifier: string | null = null;
  if (config.usePkce) {
    codeVerifier = cookieStore.get("karos_oauth_pkce")?.value ?? null;
    cookieStore.delete("karos_oauth_pkce");
    if (!codeVerifier) {
      return errorPage(
        provider,
        "We couldn't finish this connection securely — start it again.",
        origin,
      );
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

    // "google_unified" isn't a real platform doc — it's one consent screen
    // covering four. Write the SAME token pair into each of the four real
    // ClientIntegration docs so every existing per-service reader (youtube
    // publisher/analytics, google-search-console.ts, google-analytics.ts,
    // google-business-profile.ts) keeps working unchanged, unaware a unified
    // flow was involved. A Google access token is scope-checked per API call,
    // not per issuing flow, so one token pair is valid across all four.
    //
    // ...but only for the scopes the consent screen actually asked for. Business
    // Profile's business.manage is gated behind GOOGLE_BUSINESS_PROFILE_APPROVED
    // (see oauth.ts), so until Google approves it this token carries no Business
    // Profile grant. Writing an "active" google_business_profile doc anyway would
    // show the client a connected channel that 403s on every call — so drop it
    // from the fan-out unless the scope was genuinely requested. Self-heals the
    // day the flag flips; the standalone google_business_profile connector is
    // unaffected and still requests the scope on its own.
    const unifiedScopes = getRequestedScopes("google_unified");
    const platformsToWrite =
      provider === "google_unified"
        ? GOOGLE_UNIFIED_SUB_PLATFORM_IDS.filter(
            (p) =>
              p !== "google_business_profile" ||
              unifiedScopes.includes("https://www.googleapis.com/auth/business.manage"),
          )
        : [provider];

    for (const platform of platformsToWrite) {
      // Each sub-service has its own notion of "account" (e.g. the YouTube channel
      // title vs. the Search Console site URL) — re-derive it per platform instead
      // of stamping the unified flow's Google-account email onto all four, which
      // would blow away a more specific name (e.g. a YouTube channel title) that a
      // prior standalone connect had already captured.
      const platformAccountName =
        provider === "google_unified" ? await fetchAccountName(platform, accessToken) : accountName;
      await upsertClientIntegration({
        clientId: parsed.clientId,
        platform,
        credentials,
        accountName: platformAccountName || accountName || undefined,
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
      await autoCompleteTasksOnIntegrationConnect(parsed.clientId, platform).catch(() => {});
    }

    return successPage(provider, accountName, origin);
  } catch (e) {
    // STATED HOLE, and it is the bigger half of this popup's copy problem: on the
    // common path `e.message` is reflected verbatim, and the throws above are not
    // written for this reader — `Token exchange failed (400)`, `Unsupported
    // provider: …`, plus whatever `error_description` TikTok returns. Same for the
    // provider's own `error` at the top of this handler, which is a raw OAuth code
    // reflected as prose — and `access_denied` is what a provider sends when the
    // client simply cancels on the consent screen, so that path is an ordinary
    // outcome rather than a rare fault. Both are left alone here
    // deliberately: replacing them is a product call about what a client is told
    // when a connection fails and what a cancel should say, not a copy pass, and
    // guessing at it would trade a jargon message for a wrong one. Only the
    // literals this handler writes itself are fixed.
    const message = e instanceof Error ? e.message : "Something went wrong connecting that channel — try again.";
    return errorPage(provider, message, origin);
  }
}
