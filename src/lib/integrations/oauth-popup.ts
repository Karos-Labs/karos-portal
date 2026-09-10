/**
 * HTML shells for the OAuth popup window.
 *
 * The popup is opened by IntegrationsTab, which listens for
 * `karos_oauth_success` / `karos_oauth_error` postMessages from it. A plain
 * text body therefore leaves the parent card stuck on "Connecting…" forever
 * with the reason visible only inside a blank popup (QA F55), so BOTH the
 * authorize route and the callback route answer with these pages.
 */

/**
 * "This provider has no OAuth config" — said once, because BOTH routes ask it.
 *
 * The authorize route asks before opening the consent screen and the callback
 * route asks again when one comes back, and the fact is the same at both: there
 * is no `OAUTH_CONFIGS` entry, so the portal cannot connect this channel. The
 * callback answered that fact with "Unknown provider." — the URL segment the
 * client never saw, and nothing they can act on. Giving it the authorize route's
 * sentence by COPYING it would have left one fact with two spellings, so the
 * sentence lives here and both routes ask for it; it is true at both sites.
 */
export const OAUTH_UNSUPPORTED_CHANNEL_MESSAGE =
  "This channel isn't connectable from the portal yet.";

const BASE_STYLE = `*{box-sizing:border-box;margin:0;padding:0}body{background:#07090b;color:#e5e7eb;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{text-align:center;padding:2rem;max-width:320px}.icon{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.25rem}h2{font-size:1.125rem;font-weight:600;margin-bottom:.5rem;color:#fff}p{color:#6b7280;font-size:.875rem;line-height:1.5}`;

export function htmlPage(body: string, script: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Karos CMO</title><style>${BASE_STYLE}</style></head><body><div class="card">${body}</div><script>${script}<\/script></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Serialize a value for interpolation INSIDE a <script> element.
 *
 * JSON.stringify escapes quotes and backslashes but leaves `<` alone, so a
 * value containing `</script>` closes the element and everything after it is
 * parsed as HTML. That is reachable unauthenticated: the callback route
 * reflects the provider's `error_description` (and the authorize route the URL
 * path segment) before any state/CSRF check. Escaping `<` as < keeps the
 * payload a string literal in every case.
 */
export function js(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/</g, "\\u003c");
}

export function successPage(platform: string, accountName: string, origin: string): Response {
  const body = `<div class="icon" style="background:#FF6B2C22"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#FF6B2C" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div><h2>Connected!</h2><p>Closing window…</p>`;
  const script = `(function(){var o=window.opener;if(o&&!o.closed){o.postMessage({type:"karos_oauth_success",platform:${js(platform)},accountName:${js(accountName)}},${js(origin)});setTimeout(function(){window.close()},800)}else{document.querySelector("p").textContent="You can close this window."}})()`;
  return htmlPage(body, script);
}

export function errorPage(
  platform: string,
  message: string,
  origin: string,
  status = 200,
): Response {
  const body = `<div class="icon" style="background:#ef444422"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/></svg></div><h2>Connection failed</h2><p>${esc(message)}</p>`;
  const script = `(function(){var o=window.opener;if(o&&!o.closed){o.postMessage({type:"karos_oauth_error",platform:${js(platform)},error:${js(message)}},${js(origin)});setTimeout(function(){window.close()},1500)}else{document.querySelector("p").textContent+=" You can close this window."}})()`;
  return htmlPage(body, script, status);
}
