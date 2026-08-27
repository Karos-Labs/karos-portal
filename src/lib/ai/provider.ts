import "server-only";

import type { LanguageModel, streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "@/lib/constants";
import {
  CAPABILITY_VARIANT,
  missingCapabilities,
  type Capability,
  type Vendor,
} from "./capabilities";
import { AI_ROLE_NAMES, roleSpec, type AiRoleName, type ModelTier } from "./roles";

/**
 * The seam between "what a call site needs" and "which vendor serves it".
 *
 * The point of this file is that it REFUSES. If the configured vendor cannot
 * supply what a role declared, the module throws on import — not on the next
 * report run, not when someone notices the site audit stopped citing sources.
 *
 * There are two independent reasons a vendor can be unusable, and they are kept
 * apart because they have different lifetimes:
 *
 *   1. CAPABILITY — the vendor cannot do a thing a role depends on. A product
 *      constraint. Fixed only by the vendor gaining the feature, or by changing
 *      what the prompt claims.
 *   2. BINDABILITY — the vendor's SDK cannot be plugged into this repo's `ai`
 *      version at all. A dependency constraint, fixed by an upgrade.
 *
 * Both are checked at wiring. Conflating them would hide (1) — the durable,
 * nine-call-site finding — behind (2), which is a version bump.
 */

/** `tools` as `streamText`/`generateText` accept it, matching report-stream.ts's idiom. */
type ToolSet = NonNullable<Parameters<typeof streamText>[0]["tools"]>;

/** Per-call budgets for a declared capability. These vary per call site, so they are not in the manifest. */
export interface CapabilityBudgets {
  web_search?: { maxUses?: number };
  web_fetch?: { maxUses?: number; maxContentTokens?: number };
}

/**
 * Model ids per vendor.
 *
 * NOT one constant reused across both. Vertex addresses dated snapshots with an
 * `@` separator, so `claude-haiku-4-5-20251001` is simply not a model id there —
 * it is `claude-haiku-4-5@20251001`. Reusing `MODELS` verbatim would fail at
 * request time with an opaque 404, which is the class of late failure this layer
 * exists to prevent.
 */
const MODEL_IDS: Readonly<Record<Vendor, Readonly<Record<ModelTier, string>>>> = {
  anthropic: { SONNET: MODELS.SONNET, HAIKU: MODELS.HAIKU },
  vertex: { SONNET: "claude-sonnet-4-6", HAIKU: "claude-haiku-4-5@20251001" },
} as const;

/**
 * Why a vendor cannot be BOUND on the current dependency set, or `null` if it can.
 *
 * `@ai-sdk/google-vertex` is installed and its capability surface is real and
 * asserted against — but no release of it can be plugged into this repo today:
 *
 *   ai@6.0.208            -> @ai-sdk/provider@3  (LanguageModel = V2 | V3)
 *   @ai-sdk/anthropic@3   -> @ai-sdk/provider@3  (emits V3)          ✓
 *   @ai-sdk/google-vertex@5.0.66 (latest)
 *                         -> @ai-sdk/provider@4  (emits V4)          ✗
 *
 * There is no google-vertex release on the provider@3 line — the package only
 * ever shipped against provider@4, alongside ai@7 / @ai-sdk/anthropic@4. So
 * binding Vertex is not a provider-layer problem; it is an `ai` 6→7 plus
 * `@ai-sdk/anthropic` 3→4 major upgrade, which touches every streaming call
 * site in the repo and is larger than the sweep this layer was built for.
 *
 * Recorded here rather than in a ticket so the next person hits it at wiring
 * time with the reason in hand, instead of rediscovering it from a type error.
 */
const VENDOR_UNBINDABLE: Readonly<Record<Vendor, string | null>> = {
  anthropic: null,
  vertex:
    "@ai-sdk/google-vertex@5 emits LanguageModelV4 (@ai-sdk/provider@4), but this repo's " +
    "ai@6 + @ai-sdk/anthropic@3 are on @ai-sdk/provider@3 and accept V2|V3 only. No " +
    "google-vertex release exists on the provider@3 line. Binding Vertex requires " +
    "upgrading ai 6->7 and @ai-sdk/anthropic 3->4 first.",
} as const;

/** Thrown when a role cannot be wired. Always a misconfiguration, never a runtime condition. */
export class ProviderWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderWiringError";
  }
}

/**
 * The vendor everything routes to unless a role pins itself.
 * Unset ⇒ "anthropic", i.e. exactly today's behaviour.
 */
export function defaultVendor(env: Record<string, string | undefined> = process.env): Vendor {
  const raw = env.AI_VENDOR?.trim();
  if (!raw) return "anthropic";
  if (raw !== "anthropic" && raw !== "vertex") {
    throw new ProviderWiringError(
      `AI_VENDOR must be "anthropic" or "vertex" (got ${JSON.stringify(raw)}).`,
    );
  }
  return raw;
}

/** The vendor a role resolves to: its pin if it has one, else the configured default. */
export function vendorForRole(role: AiRoleName, fallback: Vendor): Vendor {
  return roleSpec(role).pinnedTo?.vendor ?? fallback;
}

/** Every vendor any role would actually resolve to under `fallback`. */
function vendorsInUse(fallback: Vendor): Vendor[] {
  const seen = new Set<Vendor>();
  for (const role of AI_ROLE_NAMES) seen.add(vendorForRole(role, fallback));
  return [...seen];
}

/**
 * CHECK 1 — capability. Every role against the vendor it would resolve to,
 * reporting ALL violations at once: someone flipping the vendor wants the full
 * bill, not to rediscover it eight more times.
 */
export function assertManifestWirable(fallback: Vendor): void {
  const failures: string[] = [];

  for (const role of AI_ROLE_NAMES) {
    const spec = roleSpec(role);
    const vendor = vendorForRole(role, fallback);
    const missing = missingCapabilities(vendor, spec.requires ?? []);
    if (missing.length > 0) {
      failures.push(
        `  ${role} needs ${missing.map((c) => `"${c}"`).join(", ")} — ` +
          `vendor "${vendor}" cannot supply ${missing.length === 1 ? "it" : "them"} ` +
          `(${spec.sites.join(", ")})`,
      );
    }
  }

  if (failures.length > 0) {
    throw new ProviderWiringError(
      `${failures.length} role${failures.length === 1 ? "" : "s"} cannot be wired to vendor ` +
        `"${fallback}":\n${failures.join("\n")}\n\n` +
        `These call sites depend on a server-side vendor feature. Routing them anyway would ` +
        `not error at run time — the model would answer without the tool, and prompts that ` +
        `promise to report only what they observed would keep promising it. Either keep them ` +
        `on a vendor that supplies the capability (pin them in roles.ts with a reason), or ` +
        `change what those prompts claim.`,
    );
  }
}

/** CHECK 2 — bindability. Separate from capability, and separately fixable. */
export function assertVendorsBindable(fallback: Vendor): void {
  for (const vendor of vendorsInUse(fallback)) {
    const reason = VENDOR_UNBINDABLE[vendor];
    if (reason) {
      throw new ProviderWiringError(
        `Vendor "${vendor}" cannot be bound on the current dependency set.\n  ${reason}`,
      );
    }
  }
}

/** Build the tool set for a role's declared capabilities, using the vendor's own factories. */
function toolsFor(role: AiRoleName, vendor: Vendor, budgets: CapabilityBudgets): ToolSet {
  const declared = roleSpec(role).requires ?? [];

  // A budget for something the role never declared means the call site is about
  // to use a capability the manifest cannot see — the exact drift this layer
  // exists to prevent, so it errors rather than being silently ignored.
  for (const key of Object.keys(budgets) as Capability[]) {
    if (!declared.includes(key)) {
      throw new ProviderWiringError(
        `Role "${role}" passed a budget for "${key}" but does not declare it in roles.ts. ` +
          `Declare the capability (so the wiring assertion can see it) or drop the budget.`,
      );
    }
  }

  const tools: Record<string, unknown> = {};
  for (const capability of declared) {
    // Re-checked here as well as in the import-time assertion: this function is
    // reachable with an explicit vendor, and a guard that only runs at import is
    // a guard that stops running the moment someone adds a parameter.
    if (missingCapabilities(vendor, [capability]).length > 0) {
      throw new ProviderWiringError(
        `Role "${role}" requires "${capability}", which vendor "${vendor}" cannot supply.`,
      );
    }
    if (capability === "web_search") {
      tools.web_search = anthropic.tools.webSearch_20250305(budgets.web_search ?? {});
    } else {
      tools.web_fetch = anthropic.tools.webFetch_20250910(budgets.web_fetch ?? {});
    }
  }
  return tools as ToolSet;
}

export interface ResolvedAi {
  readonly model: LanguageModel;
  readonly tools: ToolSet;
  readonly vendor: Vendor;
  /** Which tool variants were wired, so a downgrade is visible rather than silent. */
  readonly variants: Partial<Record<Capability, string>>;
}

/**
 * Resolve a role to a concrete model plus the tools it declared.
 *
 * Call sites take BOTH from here. Returning only a model would leave the
 * `anthropic.tools.*` factories hardcoded at the call site, so a future Vertex
 * model would be handed Anthropic-namespace tools — a seam that moves the model
 * but not the thing that made the model special is not a seam.
 */
export function aiFor(
  role: AiRoleName,
  opts: { modelId?: string; budgets?: CapabilityBudgets; vendor?: Vendor } = {},
): ResolvedAi {
  const spec = roleSpec(role);
  const vendor = opts.vendor ?? vendorForRole(role, defaultVendor());

  // Capability first: it is the durable constraint and the more interesting
  // failure. A caller asking for a vertex-unsupported capability should be told
  // that, not told about a dependency version.
  const missing = missingCapabilities(vendor, spec.requires ?? []);
  if (missing.length > 0) {
    throw new ProviderWiringError(
      `Role "${role}" requires "${missing[0]}", which vendor "${vendor}" cannot supply.`,
    );
  }

  const unbindable = VENDOR_UNBINDABLE[vendor];
  if (unbindable) {
    throw new ProviderWiringError(
      `Role "${role}" resolves to vendor "${vendor}", which cannot be bound.\n  ${unbindable}`,
    );
  }

  let modelId: string;
  if (spec.tier === "caller") {
    if (!opts.modelId) {
      throw new ProviderWiringError(
        `Role "${role}" is tier "caller" and needs an explicit modelId.`,
      );
    }
    modelId = opts.modelId;
  } else {
    if (opts.modelId) {
      throw new ProviderWiringError(
        `Role "${role}" is pinned to tier "${spec.tier}"; passing a modelId would bypass ` +
          `the per-vendor id mapping. Change the tier in roles.ts instead.`,
      );
    }
    modelId = MODEL_IDS[vendor][spec.tier];
  }

  const tools = toolsFor(role, vendor, opts.budgets ?? {});
  const variants: Partial<Record<Capability, string>> = {};
  for (const c of spec.requires ?? []) variants[c] = CAPABILITY_VARIANT[vendor][c];

  // Only `anthropic` is bindable today; the guard above has already returned for
  // anything else, so this is the single vendor branch rather than a default.
  return { model: anthropic(modelId), tools, vendor, variants };
}

/** The per-vendor model id a role would use. Exported so the mapping is testable without binding. */
export function modelIdFor(role: AiRoleName, vendor: Vendor): string | null {
  const spec = roleSpec(role);
  return spec.tier === "caller" ? null : MODEL_IDS[vendor][spec.tier];
}

// ── Wiring time ──────────────────────────────────────────────────────────────
// Importing this module validates the whole manifest against the configured
// vendor. In Next.js the failure surfaces on boot / first render of any route
// that touches AI — loudly, with the full list — rather than as a quietly worse
// report weeks later.
assertManifestWirable(defaultVendor());
assertVendorsBindable(defaultVendor());
