/**
 * The copilot chat's cost-based model routing, plus its manual override.
 *
 * T-B3/SCRUM-246. Before this file, `chat/route.ts` picked between exactly two
 * models with one hardcoded ternary (`body.deep ? MODELS.SONNET : MODELS.HAIKU`)
 * and `deep` could only ever be `true` from the three hardcoded proactive-action
 * chips (chatbot-widget.tsx's `buildProactiveActions()`) — there was no way for
 * a client to ask for a specific model themselves.
 *
 * ── Why an allowlist file, and why it lives in `src/lib/ai/` ────────────────
 * `chat.client` is (and stays) a "caller"-tier role in `roles.ts`: the one role
 * the manifest already lets a call site choose a model for at request time. The
 * mistake T-B3 must not repeat is trusting THAT choice when it comes from the
 * browser. `body.model` on the chat request is untrusted input exactly like
 * `body.messages` — a client could send literally anything, including another
 * vendor's private/expensive model id, a nonsense string, or (worst case) an
 * id string as an injection vector into whatever downstream system reads
 * `modelName`. `resolveChatModel()` below is the ONLY thing allowed to turn
 * that field into a `{ vendor, modelId }` pair, and it does so by exact-key
 * lookup against `CHAT_MODEL_OPTIONS` — never by passing the string through.
 * A `body.model` that is not one of these keys is not "clamped" or
 * "sanitized"; it is IGNORED, same as if it had been absent.
 *
 * This sits next to `roles.ts`/`provider.ts` rather than inside the route
 * because the manual model PICKER is client-visible UI
 * (`components/chatbot-widget.tsx` imports `CHAT_MODEL_OPTIONS` for its
 * labels) — a plain data module with no `server-only` import, like
 * `capabilities.ts`, so it is safe for both sides to read. The actual vendor
 * SDK binding never happens here; it happens once, in `provider.ts`'s
 * `aiFor()`, same as every other call site.
 */

import type { Vendor } from "./capabilities";
import { MODELS } from "@/lib/constants";

export interface ChatModelOption {
  /** Passed straight through to `aiFor("chat.client", { vendor, modelId })`. */
  readonly vendor: Vendor;
  readonly modelId: string;
  /** Shown on the manual picker. */
  readonly label: string;
  readonly description: string;
}

/**
 * THE SERVER-SIDE ALLOWLIST. Every model the copilot chat may ever bind to,
 * keyed on a short opaque string that is the only thing the browser is ever
 * trusted to name.
 *
 * Two entries today, matching exactly what the ticket specifies — cheap
 * Gemini by default, Haiku for a quality request — not a larger menu. Adding
 * a third (e.g. a Sonnet "max quality" tier) is a one-line addition here; it
 * is not implied by "manual override" and this file does not invent it.
 *
 * `"gemini-2.5-flash"` (not the SEO/GEO capture's `"gemini-flash-latest"`,
 * `SEO_GEO_CAPTURE.GEMINI_MODEL`, which calls the public Gemini API directly
 * with its own `GEMINI_API_KEY` for an unrelated purpose — measuring what
 * that consumer product says) is deliberately the id already priced in
 * `MODEL_PRICING_BY_VENDOR.google` (`lib/models/usage-log.ts`) and reachable
 * on the SAME Vertex AI project/credentials `vertexAnthropic` already uses —
 * a new vendor account, not a new model id, would have been the second,
 * parallel routing mechanism the ticket says not to build.
 */
export const CHAT_MODEL_OPTIONS = {
  "gemini-flash": {
    vendor: "google",
    modelId: "gemini-2.5-flash",
    label: "Fast",
    description: "Cheapest model. The copilot's default for everyday questions.",
  },
  haiku: {
    vendor: "anthropic",
    modelId: MODELS.HAIKU,
    label: "Quality",
    description:
      "Claude Haiku. Used automatically for the multi-step proactive actions, or pick it yourself for a harder question.",
  },
} as const satisfies Record<string, ChatModelOption>;

export type ChatModelKey = keyof typeof CHAT_MODEL_OPTIONS;

/** Every allowed key, for the picker UI to render without hardcoding a second copy of the list. */
export const CHAT_MODEL_KEYS = Object.keys(CHAT_MODEL_OPTIONS) as ChatModelKey[];

/**
 * Cost-based default: the cheap model, when nobody asked for anything else.
 *
 * HELD AT `haiku` PENDING VERTEX CONFIG, deliberately — this is NOT what T-B3
 * specifies, and it is one line to put back.
 *
 * `googleVertex()` validates `GOOGLE_VERTEX_LOCATION` synchronously at
 * construction, unlike `vertexAnthropic()` which defers. Neither
 * `GOOGLE_VERTEX_PROJECT` nor `GOOGLE_VERTEX_LOCATION` is set anywhere this
 * repo deploys from: `cloudbuild.yaml`'s `--set-env-vars` passes
 * `GOOGLE_CLOUD_PROJECT` and neither of those two, `.env.example` does not
 * name them, and the only occurrences in the tree are the `vi.stubEnv` calls
 * in this module's own routing test. Shipping `gemini-flash` as the default
 * would therefore have made EVERY non-deep copilot turn — the most common
 * path in the product — throw at model construction on the first deploy.
 *
 * Everything else T-B3 built ships unchanged: the allowlist, the manual
 * Fast/Quality picker, and `gemini-flash` as a selectable, priced option. A
 * client who picks "Fast" still gets it. Only which option is DEFAULT is held
 * back, so the failure is opt-in and visible rather than universal.
 *
 * TO RESTORE: confirm the Cloud Run services carry `GOOGLE_VERTEX_PROJECT` +
 * `GOOGLE_VERTEX_LOCATION` and that the Vertex project has Gemini model
 * access, then set this back to `"gemini-flash"`. Nothing else changes.
 */
export const DEFAULT_CHAT_MODEL_KEY: ChatModelKey = "haiku";
/** What `deep: true` (the 3 proactive-action chips) resolves to. */
export const DEEP_CHAT_MODEL_KEY: ChatModelKey = "haiku";

/**
 * True only for an exact, own-property match against the allowlist above.
 *
 * `unknown` on purpose — the caller is always `JSON.parse()`'d request-body
 * input, which could be a number, an object, `__proto__`, anything. This is
 * the ONE gate between that and a vendor call, so it does not trust the
 * input's shape any further than "is this string literally one of our keys".
 * `hasOwnProperty` rather than `in` or a bracket-index truthiness check for
 * the standard reason: `"toString" in CHAT_MODEL_OPTIONS` is `true`.
 */
export function isChatModelKey(value: unknown): value is ChatModelKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHAT_MODEL_OPTIONS, value);
}

export interface ResolvedChatModel {
  readonly key: ChatModelKey;
  readonly option: ChatModelOption;
  /** True when `requestedModel` was a valid, honored manual override. */
  readonly manual: boolean;
}

/**
 * One chat turn's model choice.
 *
 * Priority: a valid manual override wins outright — a client who explicitly
 * picked "Quality" gets Haiku even on a turn `deep` would not otherwise have
 * flagged, and picking "Fast" is honored even for one of the three proactive
 * actions that set `deep: true`. An INVALID `requestedModel` (missing, wrong
 * type, or any string not in the allowlist) falls through to the existing
 * `deep`-based cost routing exactly as if the field had never been sent —
 * this function has no "reject the request" outcome, only "what model do we
 * use", because a bad picker value is not a reason to fail someone's chat
 * message.
 */
export function resolveChatModel(opts: { deep?: boolean; requestedModel?: unknown }): ResolvedChatModel {
  if (isChatModelKey(opts.requestedModel)) {
    return { key: opts.requestedModel, option: CHAT_MODEL_OPTIONS[opts.requestedModel], manual: true };
  }
  const key = opts.deep ? DEEP_CHAT_MODEL_KEY : DEFAULT_CHAT_MODEL_KEY;
  return { key, option: CHAT_MODEL_OPTIONS[key], manual: false };
}
