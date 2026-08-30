import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be hoisted before any import that transitively pulls in server-only.
vi.mock("server-only", () => ({}));

import {
  CHAT_MODEL_KEYS,
  CHAT_MODEL_OPTIONS,
  DEEP_CHAT_MODEL_KEY,
  DEFAULT_CHAT_MODEL_KEY,
  isChatModelKey,
  resolveChatModel,
} from "../chat-models";
import { roleSpec } from "../roles";
import { aiFor, ProviderWiringError, usageFor } from "../provider";
import { MODEL_PRICING_BY_VENDOR } from "@/lib/models/usage-log";
import { VERTEX_MODELS } from "@/lib/constants";

/**
 * T-B3 / SCRUM-246: cost-based routing plus a manual model picker for the
 * copilot chat, replacing the hardcoded `body.deep ? SONNET : HAIKU`.
 *
 * These tests exercise the real decision function (`resolveChatModel`) and
 * the real binding path (`aiFor("chat.client", ...)`) — not a type-check —
 * so a regression that silently let an untrusted string through, or that
 * pointed the "cheap default" at something other than Gemini, fails here.
 */

describe("CHAT_MODEL_OPTIONS is the allowlist and matches the ticket's target", () => {
  it("defaults to a cheap Gemini model, not Haiku or Sonnet", () => {
    // The hold this briefly sat under is lifted: GOOGLE_VERTEX_PROJECT and
    // GOOGLE_VERTEX_LOCATION are set by both deploy configs, both portal
    // runtime service accounts hold roles/aiplatform.user, and
    // gemini-2.5-flash answered a real call in both projects.
    const def = CHAT_MODEL_OPTIONS[DEFAULT_CHAT_MODEL_KEY];
    expect(def.vendor).toBe("google");
    expect(def.modelId).toMatch(/^gemini-/);
  });

  it("gives the picker three distinct behaviours: Auto routes, Fast is Gemini, Quality is Haiku", () => {
    // The widget's "Auto" sends no `model` at all, so it falls through to
    // `deep`-based routing. Auto and Quality collapsing onto the same model
    // is exactly what the Haiku hold caused, and this is the assertion that
    // catches it if the default is ever pinned to the deep tier again.
    expect(resolveChatModel({}).option.vendor).toBe("google");
    expect(resolveChatModel({ deep: true }).option.vendor).toBe("vertex");
    expect(resolveChatModel({ requestedModel: "gemini-flash" }).option.modelId).toMatch(/^gemini-/);
    expect(resolveChatModel({ requestedModel: "haiku" }).option.modelId).toBe(VERTEX_MODELS.HAIKU);
    expect(DEFAULT_CHAT_MODEL_KEY).not.toBe(DEEP_CHAT_MODEL_KEY);
  });

  it("routes a quality/deep request to Haiku, not Sonnet — and through Vertex, not first-party Anthropic", () => {
    const deep = CHAT_MODEL_OPTIONS[DEEP_CHAT_MODEL_KEY];
    expect(deep.vendor).toBe("vertex");
    // The "@" spelling, not MODELS.HAIKU's dashed one. Vertex addresses a
    // dated snapshot with "@" and 404s on the first-party form, so this
    // assertion is the difference between a working option and an opaque
    // runtime failure.
    expect(deep.modelId).toBe(VERTEX_MODELS.HAIKU);
    expect(deep.modelId).toContain("@");
  });

  it("keeps both chat options on one vendor account — nothing routes to first-party Anthropic", () => {
    // The point of moving Quality onto Vertex: both options now bill to one
    // Google invoice against one credential. A future option added with
    // vendor "anthropic" reintroduces the split bill SCRUM-361 had to unpick
    // on the engine side, so it fails here rather than at reconciliation.
    for (const key of CHAT_MODEL_KEYS) {
      expect(CHAT_MODEL_OPTIONS[key].vendor, `chat option "${key}"`).not.toBe("anthropic");
    }
  });

  it("prices every allowlisted (vendor, modelId) pair — a picker option that cannot be costed is a bug here, not at bill time", () => {
    for (const key of CHAT_MODEL_KEYS) {
      const opt = CHAT_MODEL_OPTIONS[key];
      const table = MODEL_PRICING_BY_VENDOR[opt.vendor as keyof typeof MODEL_PRICING_BY_VENDOR];
      expect(table, `no pricing table for vendor "${opt.vendor}" (option "${key}")`).toBeDefined();
      expect(table[opt.modelId], `"${key}" -> (${opt.vendor}, ${opt.modelId}) is unpriced`).toBeDefined();
    }
  });
});

describe("isChatModelKey — the gate between untrusted request-body input and the allowlist", () => {
  it("accepts only the exact allowlisted keys", () => {
    for (const key of CHAT_MODEL_KEYS) expect(isChatModelKey(key)).toBe(true);
  });

  it("refuses anything not in the allowlist, whatever shape it arrives in", () => {
    expect(isChatModelKey("claude-sonnet-4-6")).toBe(false); // a raw vendor model id
    expect(isChatModelKey("gemini-2.5-pro")).toBe(false); // a real Gemini id, just not an allowlisted key
    expect(isChatModelKey("Haiku")).toBe(false); // case-sensitive — no normalization to smuggle a near-miss through
    expect(isChatModelKey("")).toBe(false);
    expect(isChatModelKey(undefined)).toBe(false);
    expect(isChatModelKey(null)).toBe(false);
    expect(isChatModelKey(123)).toBe(false);
    expect(isChatModelKey({ modelId: "haiku" })).toBe(false);
    expect(isChatModelKey(["haiku"])).toBe(false);
  });

  it("does not fall for prototype-pollution-style lookups", () => {
    // `"toString" in CHAT_MODEL_OPTIONS` is true; hasOwnProperty must not be.
    expect(isChatModelKey("toString")).toBe(false);
    expect(isChatModelKey("__proto__")).toBe(false);
    expect(isChatModelKey("constructor")).toBe(false);
  });
});

describe("resolveChatModel — the actual cost-based routing + manual override", () => {
  it("defaults to DEFAULT_CHAT_MODEL_KEY with no deep flag and no requested model", () => {
    const r = resolveChatModel({});
    expect(r.key).toBe(DEFAULT_CHAT_MODEL_KEY);
    expect(r.manual).toBe(false);
  });

  it("routes a deep request to Haiku when there is no manual override", () => {
    const r = resolveChatModel({ deep: true });
    expect(r.key).toBe("haiku");
    expect(r.manual).toBe(false);
  });

  it("a valid manual override wins even when deep is NOT set", () => {
    const r = resolveChatModel({ deep: false, requestedModel: "haiku" });
    expect(r.key).toBe("haiku");
    expect(r.manual).toBe(true);
  });

  it("a valid manual override wins even OVER a deep request — picking Fast overrides a proactive chip", () => {
    const r = resolveChatModel({ deep: true, requestedModel: "gemini-flash" });
    expect(r.key).toBe("gemini-flash");
    expect(r.manual).toBe(true);
  });

  it("an INVALID requestedModel is ignored outright, falling back to deep-based routing — never surfaced as an error", () => {
    // Asserted against the constants, not against literals: what this test is
    // for is that an unrecognized value is IGNORED and routing falls through
    // to the deep-based default — which stays true whichever option is default.
    expect(resolveChatModel({ deep: false, requestedModel: "claude-opus-4-8" }).key).toBe(DEFAULT_CHAT_MODEL_KEY);
    expect(resolveChatModel({ deep: true, requestedModel: "claude-opus-4-8" }).key).toBe(DEEP_CHAT_MODEL_KEY);
    expect(resolveChatModel({ requestedModel: 42 }).key).toBe(DEFAULT_CHAT_MODEL_KEY);
    expect(resolveChatModel({ requestedModel: { modelId: "haiku" } }).key).toBe(DEFAULT_CHAT_MODEL_KEY);
    expect(resolveChatModel({ requestedModel: null }).key).toBe(DEFAULT_CHAT_MODEL_KEY);
  });

  it("never returns an option outside the allowlist, whatever the input", () => {
    for (const requestedModel of [undefined, null, 1, "nope", {}, [], "__proto__"]) {
      for (const deep of [true, false, undefined]) {
        const r = resolveChatModel({ deep, requestedModel });
        expect(CHAT_MODEL_KEYS).toContain(r.key);
      }
    }
  });
});

describe("aiFor(\"chat.client\", ...) actually binds through the capability-aware provider layer — no second routing mechanism", () => {
  // Binding a Gemini model, unlike vertexAnthropic's lazy Claude-on-Vertex
  // binding, validates GOOGLE_VERTEX_LOCATION synchronously at construction
  // (AI_LoadSettingError otherwise) — a real deployment already sets this for
  // vertexAnthropic (T-B1), so these two tests stub what production already
  // configures rather than proving something the SDK doesn't require.
  beforeEach(() => {
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "test-project");
    vi.stubEnv("GOOGLE_VERTEX_LOCATION", "us-central1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("binds the cost-based default to vendor google", () => {
    const chosen = resolveChatModel({});
    const resolved = aiFor("chat.client", { modelId: chosen.option.modelId, vendor: chosen.option.vendor });
    expect(resolved.vendor).toBe("google");
    expect(resolved.modelId).toBe("gemini-2.5-flash");
    expect(resolved.model).toBeDefined();
  });

  it("binds a deep/manual Haiku pick to vendor vertex", () => {
    const chosen = resolveChatModel({ deep: true });
    const resolved = aiFor("chat.client", { modelId: chosen.option.modelId, vendor: chosen.option.vendor });
    expect(resolved.vendor).toBe("vertex");
    expect(resolved.modelId).toBe(VERTEX_MODELS.HAIKU);
  });

  it("usageFor agrees with aiFor on the exact same pair — cost logging cannot diverge from what actually served the request", () => {
    for (const requestedModel of [undefined, "haiku", "gemini-flash"]) {
      const chosen = resolveChatModel({ requestedModel });
      const opts = { modelId: chosen.option.modelId, vendor: chosen.option.vendor };
      const resolved = aiFor("chat.client", opts);
      const usage = usageFor("chat.client", opts);
      expect(usage.vendor).toBe(resolved.vendor);
      expect(usage.modelName).toBe(resolved.modelId);
    }
  });

  it("chat.client stays a caller-tier role with no capability requirements — it is still the ONE role this file's routing may pick a vendor for", () => {
    expect(roleSpec("chat.client").tier).toBe("caller");
    expect(roleSpec("chat.client").requires ?? []).toEqual([]);
    expect(roleSpec("chat.client").pinnedTo).toBeUndefined();
  });
});

describe("vendor \"google\" cannot leak onto a tiered role — the guard that keeps Gemini reachable only through chat-models.ts", () => {
  it("a SONNET/HAIKU-tiered role refuses to resolve against vendor google", () => {
    // asset.title is tier HAIKU with no capability requirements — the plainest
    // possible tiered role, picked so this failure is clearly about the
    // vendor/tier mismatch and not about capabilities.
    expect(() => aiFor("asset.title", { vendor: "google" })).toThrow(ProviderWiringError);
    expect(() => aiFor("asset.title", { vendor: "google" })).toThrow(/no SONNET\/HAIKU table/);
  });

  it("usageFor refuses the same pairing for the same reason", () => {
    expect(() => usageFor("asset.title", { vendor: "google" })).toThrow(ProviderWiringError);
  });
});
