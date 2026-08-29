/**
 * What each model vendor can actually do, and the check that stops us wiring a
 * call site to a vendor that cannot do what the call site depends on.
 *
 * This file is pure data + pure functions on purpose: no SDK imports, no env,
 * no `server-only`. The matrix is the thing most likely to be wrong later, so
 * it has to be trivially testable.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Nine of this repo's model call sites depend on Anthropic's SERVER-SIDE web
 * tools. Those are not model behaviour, they are a vendor feature, and the
 * vendors do not agree on which ones exist. A model swap that silently drops
 * `web_fetch` does not throw — the model simply answers from its weights. For
 * `intel/seo-geo.ts`, whose system prompt says "You measure, you never guess:
 * every check verdict cites what you actually observed this run", that is worse
 * than an outage: the audit keeps producing CONFIRMED verdicts having lost the
 * faculty that let it confirm anything.
 *
 * So capability is declared, not assumed, and a mismatch fails at WIRING time.
 */

/**
 * A server-side vendor feature a call site can depend on.
 *
 * Deliberately only the two this repo actually declares. A capability nothing
 * declares is a capability nothing verifies — if a third is needed, add it here
 * WITH the call site that requires it, not in advance.
 */
export type Capability = "web_search" | "web_fetch";

/**
 * A model vendor. "anthropic" and "vertex" both serve Anthropic models (they
 * are not equivalent — see the capability matrix below). "google" is Gemini
 * on Vertex (T-B3/SCRUM-246) — a different model family on the same
 * underlying Vertex AI project/auth, reached through
 * `@ai-sdk/google-vertex`'s default export rather than its `/anthropic`
 * subpath. It is deliberately NOT a legal `AI_VENDOR` value (`defaultVendor()`
 * in provider.ts still only accepts "anthropic"/"vertex") — nothing in the
 * 43-site manifest is meant to bulk-route to Gemini. It is reachable only as
 * an explicit per-call `vendor` on a "caller"-tier role, which today is only
 * `chat.client` (see `src/lib/ai/chat-models.ts`).
 */
export type Vendor = "anthropic" | "vertex" | "google";

/**
 * Which capabilities each vendor can supply.
 *
 * SOURCE — read from the installed SDKs' own type declarations, not from docs:
 *
 *   node_modules/@ai-sdk/anthropic/dist/index.d.ts
 *     exposes webSearch_20250305, webSearch_20260209,
 *             webFetch_20250910,  webFetch_20260209
 *
 *   node_modules/@ai-sdk/google-vertex/dist/anthropic/index.d.ts
 *     "Only a subset of Anthropic tools are available on Vertex.
 *      Supported tools: bash_*, textEditor_*, computer_20241022,
 *      webSearch_20250305, toolSearchRegex_20251119, toolSearchBm25_20251119"
 *     and the string `webFetch` does not appear anywhere in that package's dist.
 *
 * So Vertex has web search (basic variant only) and NO web fetch at all.
 *
 * If a vendor gains a capability, this map is the only edit — that is the point.
 * Do not re-derive which call sites were special; they already declared it.
 */
export const VENDOR_CAPABILITIES: Readonly<Record<Vendor, readonly Capability[]>> = {
  anthropic: ["web_search", "web_fetch"],
  vertex: ["web_search"],
  // Empty, not "whatever Gemini happens to support": no coupled role has ever
  // been asked to run on Gemini, so nothing has verified what it can do. A
  // role that later pins itself to "google" while declaring a capability
  // fails the SAME way an unsupported vertex pairing already does — loudly,
  // at wiring time — rather than silently getting a tool nobody checked.
  google: [],
} as const;

/**
 * Which variant of a capability a vendor exposes.
 *
 * Vertex tops out at the basic `webSearch_20250305`; first-party Anthropic also
 * has the newer `_20260209` filtering variants. Kept explicit so that routing a
 * site to Vertex is a visible downgrade in the diff rather than a silent one.
 */
export const CAPABILITY_VARIANT: Readonly<
  Record<Vendor, Partial<Record<Capability, string>>>
> = {
  anthropic: { web_search: "webSearch_20250305", web_fetch: "webFetch_20250910" },
  vertex: { web_search: "webSearch_20250305" },
  google: {},
} as const;

/** True when `vendor` can supply `capability`. */
export function vendorSupports(vendor: Vendor, capability: Capability): boolean {
  return VENDOR_CAPABILITIES[vendor].includes(capability);
}

/**
 * The declared capabilities `vendor` CANNOT supply, in declaration order.
 * Empty means the pairing is wirable.
 */
export function missingCapabilities(
  vendor: Vendor,
  requires: readonly Capability[],
): Capability[] {
  return requires.filter((c) => !vendorSupports(vendor, c));
}
