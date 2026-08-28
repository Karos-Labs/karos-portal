import "server-only";

import type { LanguageModel, streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { vertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
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
 * Until the `ai` 6→7 / `@ai-sdk/anthropic` 3→4 upgrade there was a second check
 * here, for whether a vendor's SDK could be plugged into this repo at all. That
 * was a packaging problem with an expiry date, and it has expired: all three
 * provider packages now sit on `@ai-sdk/provider@4`, and Vertex is bound below.
 * The check was deleted rather than left returning `null` forever — a guard that
 * can no longer fail is not a guard, and this codebase has already found six.
 *
 * What remains is the durable constraint: CAPABILITY. A vendor that cannot do a
 * thing a role depends on is a product fact, fixed only by the vendor gaining
 * the feature or by changing what the prompt claims. Vertex still has no
 * `web_fetch`, so the nine sites that declare it still cannot route there — and
 * now that Vertex is reachable, that refusal is the only thing standing between
 * a config flip and nine prompts quietly losing the faculty they promise to use.
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
      const opts = budgets.web_search ?? {};
      // Each vendor's own factory. Handing a Vertex model an Anthropic-namespace
      // tool is the failure the seam exists to make impossible.
      tools.web_search =
        vendor === "vertex"
          ? vertexAnthropic.tools.webSearch_20250305(opts)
          : anthropic.tools.webSearch_20250305(opts);
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
  /**
   * The model id this resolution actually bound — `MODEL_IDS[vendor][tier]`.
   *
   * Returned because it was already computed and thrown away: cost logging then
   * had nothing to log but the tier CONSTANT, which agrees with the resolved id
   * on first-party Anthropic and disagrees on Vertex. See AU70/SCRUM-370 and
   * `usageFor()` below.
   */
  readonly modelId: string;
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

  return {
    model: vendor === "vertex" ? vertexAnthropic(modelId) : anthropic(modelId),
    tools,
    vendor,
    modelId,
    variants,
  };
}

/**
 * What the cost logger must record for a role: the RESOLVED id and the vendor
 * that will serve it, as one spreadable object.
 *
 *   logger.trackStream(stream, { ...usageFor("intel.condense"), clientId, … })
 *
 * Spreadable on purpose. The pre-AU70 shape was `modelName: MODELS.SONNET` — a
 * tier constant written by hand, one line away from an `aiFor()` call that had
 * already resolved something else. Two independent facts that had to agree and
 * had nothing making them agree. Here they come from ONE call, keyed on the same
 * role, reading the same `MODEL_IDS` map `aiFor` reads, so they cannot diverge:
 * there is no argument a caller could pass to make the id and the vendor
 * disagree.
 *
 * Cheap: no SDK binding, no tool wiring — safe to call next to the log, not next
 * to the generation.
 */
export function usageFor(
  role: AiRoleName,
  opts: { modelId?: string; vendor?: Vendor } = {},
): { modelName: string; vendor: Vendor } {
  const spec = roleSpec(role);
  const vendor = opts.vendor ?? vendorForRole(role, defaultVendor());
  if (spec.tier === "caller") {
    if (!opts.modelId) {
      throw new ProviderWiringError(
        `Role "${role}" is tier "caller"; usageFor() needs the modelId the call site chose.`,
      );
    }
    return { modelName: opts.modelId, vendor };
  }
  return { modelName: MODEL_IDS[vendor][spec.tier], vendor };
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
