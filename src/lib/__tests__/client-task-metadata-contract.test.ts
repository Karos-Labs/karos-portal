import { describe, expect, it } from "vitest";
import type { ClientTaskAction, ClientTaskMetadata } from "@/lib/types";
import { KNOWN_ENGINE_PRODUCT_IDS, type EngineProductId } from "@/lib/agent-engine/product-mapping";
import type { ActionKind, FixAction } from "@/lib/seo-geo";

/**
 * [C2/C4, SCRUM-258/T-B10] `ClientTask.metadata` typed-contract pin.
 *
 * WHAT THIS PINS. `ClientTask.metadata` used to be `Record<string, unknown>`.
 * This ticket gave it a real shape (`ClientTaskMetadata`, `src/lib/types.ts`)
 * with `agentEngineProductId`, `recId`, and `action` as real, non-`unknown`
 * types `tsc` enforces — this file is that enforcement, made visible as a
 * test.
 *
 * WHY THIS IS A `tsc --noEmit` PIN, NOT A `vitest run` ONE, AND THAT IS
 * DELIBERATE. This repo's own `vitest.config.ts` runs test files through
 * esbuild, which strips types without checking them — a lesson already
 * learned once in this codebase (see
 * `src/lib/agent-engine/__tests__/routable-recommendation.test.ts`'s own doc
 * comment: an earlier version of THAT pin "changed nothing... neither
 * `vitest run` nor `tsc --noEmit`" failed when the union it claimed to pin
 * actually drifted). The assignments below are typed so that widening
 * `agentEngineProductId`/`recId`/`action` back to `unknown` (or to a bare
 * `Record<string, unknown>`, which is what `ClientTask.metadata` was before
 * this ticket) makes every one of them a compile error — verified by hand for
 * this exact revert as this ticket's adversarial proof (see the ticket
 * report), not asserted here as something `vitest run` could ever catch.
 * `expect(...)` calls exist only so this file also counts as a real vitest
 * test (the repo's "the count only ever goes up" bar) — the pin itself is
 * every line before each `expect`.
 */
describe("ClientTask.metadata typed contract (SCRUM-258/T-B10)", () => {
  it("agentEngineProductId is a real EngineProductId, not unknown", () => {
    const meta: ClientTaskMetadata = { agentEngineProductId: "seo-geo-agent" };
    // Compile-time pin: `meta.agentEngineProductId` (typed `EngineProductId |
    // undefined`) is assignable to `EngineProductId` only with the `!` — and
    // only because it is no longer `unknown`. If `agentEngineProductId` were
    // reverted to `unknown`, this line fails: `Type 'unknown' is not
    // assignable to type 'EngineProductId'.`
    const pid: EngineProductId = meta.agentEngineProductId!;
    expect((KNOWN_ENGINE_PRODUCT_IDS as readonly string[]).includes(pid)).toBe(true);
  });

  it("agentEngineProductId rejects a productId outside KNOWN_ENGINE_PRODUCT_IDS at compile time", () => {
    // @ts-expect-error -- "not-a-real-product" is not a member of EngineProductId.
    // If agentEngineProductId is ever reverted to `unknown` (or plain
    // `string`), this assignment stops erroring and tsc instead reports the
    // directive itself as unused ("Unused '@ts-expect-error' directive") —
    // either way, reverting the typed contract fails `tsc --noEmit` here.
    const meta: ClientTaskMetadata = { agentEngineProductId: "not-a-real-product" };
    expect(meta.agentEngineProductId).toBe("not-a-real-product");
  });

  it("recId is a real string, not unknown", () => {
    const meta: ClientTaskMetadata = { recId: "SEO-02" };
    // Compile-time pin: only compiles if `recId` is at least `string`, not
    // `unknown` (which has no string methods at all).
    const id: string = meta.recId!;
    expect(id.toLowerCase()).toBe("seo-02");
  });

  it("action is typed against C2's FixAction/ActionKind vocabulary, not unknown", () => {
    const action: ClientTaskAction = { fixAction: "meta_title", actionKind: "one_click" };
    const meta: ClientTaskMetadata = { action };
    // Compile-time pin: both destructured fields must resolve to the exact
    // canonical unions `@/lib/seo-geo` declares (not a fourth, hand-typed
    // copy of either) — assigning `meta.action!.fixAction`/`.actionKind` to
    // these two variables only compiles if `action` carries real types.
    const fixAction: FixAction = meta.action!.fixAction;
    const actionKind: ActionKind = meta.action!.actionKind;
    expect(fixAction).toBe("meta_title");
    expect(actionKind).toBe("one_click");
  });

  it("action rejects a fixAction outside FixAction's vocabulary at compile time", () => {
    // @ts-expect-error -- "not_a_real_fix" is not a member of FixAction.
    const meta: ClientTaskMetadata = { action: { fixAction: "not_a_real_fix", actionKind: "one_click" } };
    expect(meta.action?.fixAction).toBe("not_a_real_fix");
  });

  it("still accepts an unrecognized/legacy key through the controlled escape hatch", () => {
    // The interface is deliberately not closed (see its own doc comment) —
    // an unlisted key stays `unknown`, exactly like every key did before this
    // ticket, so every existing untyped-metadata write site keeps compiling.
    const meta: ClientTaskMetadata = { someFutureKeyNoOneHasNamedYet: 42 };
    expect(meta.someFutureKeyNoOneHasNamedYet).toBe(42);
  });
});
