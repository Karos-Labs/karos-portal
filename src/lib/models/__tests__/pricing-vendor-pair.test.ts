import { describe, expect, it } from "vitest";
import { vi } from "vitest";

// Hoisted before anything that transitively pulls in server-only (provider.ts).
vi.mock("server-only", () => ({}));

import {
  MODEL_PRICING,
  MODEL_PRICING_BY_VENDOR,
  PRICING_VENDORS,
  PricingLookupError,
  computeCostUsd,
  displayRateFor,
  priceFor,
  providerForVendor,
  resolveModelName,
  sanitizeModelKey,
} from "../usage-log";
import { AI_ROLE_NAMES, roleSpec } from "@/lib/ai/roles";
import { modelIdFor } from "@/lib/ai/provider";

/**
 * AU70 / SCRUM-370.
 *
 * The ticket's verification clause, verbatim: "a test that asserts pricing
 * lookup fails loudly — not falls back — when vendor and model id are
 * inconsistent. A lookup that always resolves is a check structurally incapable
 * of failing."
 *
 * So the first thing this file does is watch the lookup FAIL, on the exact pair
 * the Vertex switch would produce, and the second thing is prove the fallback
 * that used to swallow it is gone.
 */

describe("the pricing lookup fails loudly on an inconsistent (vendor, model id) pair", () => {
  it("REFUSES the first-party Haiku id under vendor vertex — the exact AU70 shape", () => {
    // A call site logging `MODELS.HAIKU` while AI_VENDOR=vertex produces exactly
    // this pair. Before AU70 it resolved — on the constant — and billed Vertex
    // inference at first-party rates.
    expect(() => priceFor("vertex", "claude-haiku-4-5-20251001")).toThrow(PricingLookupError);

    let caught: PricingLookupError | null = null;
    try {
      priceFor("vertex", "claude-haiku-4-5-20251001");
    } catch (err) {
      caught = err as PricingLookupError;
    }
    // The message must name both halves of the pair, because the person reading
    // it has to know which of the two is wrong.
    expect(caught).toBeInstanceOf(PricingLookupError);
    expect(caught!.vendor).toBe("vertex");
    expect(caught!.modelId).toBe("claude-haiku-4-5-20251001");
    expect(caught!.message).toContain("vertex");
    expect(caught!.message).toContain("claude-haiku-4-5-20251001");
    expect(caught!.message).toContain("anthropic");
  });

  it("REFUSES the Vertex Haiku id under vendor anthropic — the same mistake inverted", () => {
    expect(() => priceFor("anthropic", "claude-haiku-4-5@20251001")).toThrow(PricingLookupError);
  });

  it("REFUSES an id no vendor prices, instead of costing it at Sonnet's rate", () => {
    expect(() => priceFor("anthropic", "claude-nonexistent-9-9")).toThrow(PricingLookupError);
    expect(() => priceFor("vertex", "claude-nonexistent-9-9")).toThrow(PricingLookupError);
  });

  it("prices the CONSISTENT pair, so the refusal above is discrimination and not a blanket throw", () => {
    expect(priceFor("vertex", "claude-haiku-4-5@20251001")).toEqual({
      inputPer1M: 0.8,
      outputPer1M: 4.0,
    });
    expect(priceFor("anthropic", "claude-haiku-4-5-20251001")).toEqual({
      inputPer1M: 0.8,
      outputPer1M: 4.0,
    });
  });

  it("prices Vertex Haiku at Haiku's rate, NOT the 3.75x Sonnet default it used to fall to", () => {
    // The concrete latent mispricing this ticket was filed on: the flat table
    // had no `claude-haiku-4-5@20251001` key at all, so it fell to
    // `_default: { 3.00, 15.00 }`.
    const p = priceFor("vertex", "claude-haiku-4-5@20251001");
    expect(p.inputPer1M).not.toBe(3.0);
    expect(p.outputPer1M).not.toBe(15.0);
    expect(3.0 / p.inputPer1M).toBeCloseTo(3.75, 6);
    expect(15.0 / p.outputPer1M).toBeCloseTo(3.75, 6);
  });

  it("has no `_default` row left to fall back to", () => {
    expect(Object.keys(MODEL_PRICING)).not.toContain("_default");
    for (const vendor of PRICING_VENDORS) {
      expect(Object.keys(MODEL_PRICING_BY_VENDOR[vendor])).not.toContain("_default");
    }
  });

  it("makes computeCostUsd throw rather than return a plausible number", () => {
    expect(() => computeCostUsd("vertex", "claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toThrow(
      PricingLookupError,
    );
    // …and the consistent pair returns the real figure: 0.80 + 4.00.
    expect(computeCostUsd("vertex", "claude-haiku-4-5@20251001", 1_000_000, 1_000_000)).toBe(4.8);
    // What the old flat lookup would have returned for that same call.
    expect(computeCostUsd("anthropic", "claude-sonnet-4-6", 1_000_000, 1_000_000)).toBe(18);
  });
});

describe("every id the provider layer can actually resolve is priced under the vendor that serves it", () => {
  // This is the sweep that would have caught `claude-haiku-4-5@20251001` being
  // unpriced on the day it was added. It reads MODEL_IDS through the same
  // exported accessor the wiring tests use, so the two tables cannot drift.
  it("prices MODEL_IDS[vendor][tier] for every role and both vendors", () => {
    const unpriced: string[] = [];
    for (const role of AI_ROLE_NAMES) {
      if (roleSpec(role).tier === "caller") continue;
      for (const vendor of ["anthropic", "vertex"] as const) {
        const id = modelIdFor(role, vendor);
        if (!id) continue;
        try {
          priceFor(vendor, id);
        } catch {
          unpriced.push(`${role} -> ${vendor}:${id}`);
        }
      }
    }
    expect(
      unpriced,
      `these resolvable (vendor, model id) pairs have no price, so a call on them ` +
        `would be refused at log time:\n  ${unpriced.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("the surrounding helpers stopped lying about vendor", () => {
  it("bills Claude-on-Vertex to Google, not to Anthropic", () => {
    expect(providerForVendor("vertex")).toBe("google");
    expect(providerForVendor("anthropic")).toBe("anthropic");
  });

  it("keeps first-party and Vertex Haiku in SEPARATE snapshot series", () => {
    // Both ids sanitize to the same key without the vendor qualifier, which
    // would have merged two different bills into one `model_*` field.
    const bare = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_");
    expect(bare("claude-haiku-4-5-20251001")).toBe(bare("claude-haiku-4-5@20251001"));
    expect(sanitizeModelKey("claude-haiku-4-5-20251001", "anthropic")).not.toBe(
      sanitizeModelKey("claude-haiku-4-5@20251001", "vertex"),
    );
  });

  it("keeps today's key spelling for anthropic, so existing model_* series keep accumulating", () => {
    expect(sanitizeModelKey("claude-haiku-4-5-20251001", "anthropic")).toBe(
      "claude_haiku_4_5_20251001",
    );
    expect(sanitizeModelKey("gpt-4o-mini", "openai")).toBe("gpt_4o_mini");
  });

  it("round-trips both spellings through resolveModelName", () => {
    expect(resolveModelName(sanitizeModelKey("claude-haiku-4-5-20251001", "anthropic"))).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(resolveModelName(sanitizeModelKey("claude-haiku-4-5@20251001", "vertex"))).toBe(
      "claude-haiku-4-5@20251001",
    );
  });

  it("returns null rather than Sonnet's rate for an unknown display id", () => {
    expect(displayRateFor("claude-nonexistent-9-9")).toBeNull();
    expect(displayRateFor("claude-sonnet-4-6")).toEqual({ inputPer1M: 3.0, outputPer1M: 15.0 });
  });
});
