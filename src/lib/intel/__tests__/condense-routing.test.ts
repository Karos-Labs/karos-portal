import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SCRUM-387 — execution behaviour of the routing this ticket adds to
 * `condenseOne`/`runCondensationAttempts` (`condense.ts`): Vertex-primary/
 * Anthropic-fallback for a standard-complexity document, and the Opus/Gemini
 * escalation branches for a high-complexity / oversized one. The pure
 * selection logic (which model a given document's signals select) is
 * covered in `context-doc-routing.test.ts`; this file proves the model
 * choice actually reaches `streamText`, and that a primary-vendor failure is
 * genuinely retried on the fallback vendor rather than just being described
 * in a comment.
 *
 * `@ai-sdk/anthropic` / `@ai-sdk/google-vertex/anthropic` / `@ai-sdk/google-
 * vertex` are mocked to tag objects (`{__vendor, __id}`) so the "ai" mock
 * below can identify which vendor/model a given `streamText` call targeted
 * without needing real SDK credentials — the same idiom
 * `dynamic-agent-generation.test.ts` uses for `@ai-sdk/anthropic`.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/intel/brain", () => ({ CONDENSATION_RULES: "rules" }));

const trackStreamMock = vi.fn();
vi.mock("@/services/logger", () => ({
  logger: {
    trackStream: (...args: unknown[]) => trackStreamMock(...args),
    logUsage: vi.fn(),
    logGenerationFailure: vi.fn(),
    logError: vi.fn(),
  },
}));

const structuredLogMock = vi.fn();
vi.mock("@/lib/telemetry/structured-log", () => ({
  logStructured: (...args: unknown[]) => structuredLogMock(...args),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: (id: string) => ({ __vendor: "anthropic", __id: id }),
}));
vi.mock("@ai-sdk/google-vertex/anthropic", () => ({
  vertexAnthropic: (id: string) => ({ __vendor: "vertex", __id: id }),
}));
vi.mock("@ai-sdk/google-vertex", () => ({
  googleVertex: (id: string) => ({ __vendor: "google", __id: id }),
}));

interface TaggedModel {
  __vendor: "anthropic" | "vertex" | "google";
  __id: string;
}

/** Per-test controllable handler: given the model a call targeted, return text or throw. */
let handleCall: (model: TaggedModel) => string;

const streamTextMock = vi.fn((opts: { model: TaggedModel }) => {
  const text = handleCall(opts.model);
  return {
    text: Promise.resolve(text),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 10 }),
    providerMetadata: Promise.resolve(undefined),
  };
});
vi.mock("ai", () => ({ streamText: (opts: { model: TaggedModel }) => streamTextMock(opts) }));

const { condenseDocs } = await import("../condense");
const { HIGH_COMPLEXITY_MODEL, LARGE_CONTEXT_MODEL } = await import("../context-doc-routing");

const CLIENT = { id: "acme", name: "Acme" } as never;

/** A short, standard-complexity internal document with two sections. */
const SIMPLE_DOC = ["## Overview", "", "Short overview.", "", "## Notes", "", "Short notes."].join("\n");

/** A high-complexity internal document: well past HIGH_COMPLEXITY_THRESHOLD on section count alone. */
const COMPLEX_DOC = [
  "## Overview",
  "",
  "Short.",
  "",
  ...Array.from({ length: 10 }, (_, i) => [`## Extra ${i}`, "", "Some text.", ""]).flat(),
  "## Notes",
  "",
  "Short.",
].join("\n");

beforeEach(() => {
  streamTextMock.mockClear();
  trackStreamMock.mockClear();
  structuredLogMock.mockClear();
});

describe("baseline routing — Vertex-primary, Anthropic-fallback (AC1)", () => {
  it("uses Vertex on the first attempt when it succeeds, with no fallback", async () => {
    handleCall = (model) => (model.__vendor === "vertex" ? SIMPLE_DOC : "WRONG VENDOR");
    const [doc] = await condenseDocs(CLIENT, ["brand-voice"] as never, { "brand-voice": SIMPLE_DOC }, "rules");

    expect(doc.content).toBe(SIMPLE_DOC);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(streamTextMock.mock.calls[0]![0].model.__vendor).toBe("vertex");
    expect(trackStreamMock).toHaveBeenCalledTimes(1);
    expect(trackStreamMock.mock.calls[0]![1]).toMatchObject({ vendor: "vertex" });
    // No fallback event — the primary vendor was never bypassed.
    expect(
      structuredLogMock.mock.calls.some((c) => (c[2] as { event?: string } | undefined)?.event === "context_document.condense_fallback"),
    ).toBe(false);
  });

  it("falls back to direct Anthropic when Vertex fails — the fallback is a real retry, not a comment", async () => {
    handleCall = (model) => {
      if (model.__vendor === "vertex") throw new Error("vertex unavailable (503)");
      return SIMPLE_DOC;
    };
    const [doc] = await condenseDocs(CLIENT, ["brand-voice"] as never, { "brand-voice": SIMPLE_DOC }, "rules");

    expect(doc.content).toBe(SIMPLE_DOC);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(streamTextMock.mock.calls[0]![0].model.__vendor).toBe("vertex");
    expect(streamTextMock.mock.calls[1]![0].model.__vendor).toBe("anthropic");
    // The successful attempt (anthropic) is what gets billed/logged.
    expect(trackStreamMock).toHaveBeenCalledTimes(1);
    expect(trackStreamMock.mock.calls[0]![1]).toMatchObject({ vendor: "anthropic" });
    // And the fallback is visible in the structured log, not silent.
    const fallbackCall = structuredLogMock.mock.calls.find(
      (c) => (c[2] as { event?: string } | undefined)?.event === "context_document.condense_fallback",
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall![2]).toMatchObject({ from: "vertex", to: "anthropic" });
  });

  it("rejects with the last vendor's real error when EVERY candidate fails", async () => {
    handleCall = (model) => {
      throw new Error(`${model.__vendor} exploded`);
    };
    await expect(
      condenseDocs(CLIENT, ["brand-voice"] as never, { "brand-voice": SIMPLE_DOC }, "rules"),
    ).rejects.toThrow(/anthropic exploded/);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("re-attempts Vertex first on the truncation retry too — the fallback is not sticky across passes", async () => {
    let call = 0;
    handleCall = (model) => {
      call++;
      if (model.__vendor === "vertex") throw new Error("vertex unavailable");
      // anthropic: first pass truncated (missing "## Notes"), second pass complete.
      return call <= 2 ? "## Overview\n\nShort overview." : SIMPLE_DOC;
    };
    const [doc] = await condenseDocs(CLIENT, ["brand-voice"] as never, { "brand-voice": SIMPLE_DOC }, "rules");

    expect(doc.content).toBe(SIMPLE_DOC);
    // vertex(fail) + anthropic(truncated) + vertex(fail) + anthropic(complete)
    expect(streamTextMock).toHaveBeenCalledTimes(4);
    expect(streamTextMock.mock.calls.map((c) => c[0]!.model.__vendor)).toEqual([
      "vertex",
      "anthropic",
      "vertex",
      "anthropic",
    ]);
  });
});

describe("complexity-driven escalation reaches streamText (AC2)", () => {
  it("routes a high-complexity document straight to Opus, anthropic-only — no Vertex attempt at all", async () => {
    handleCall = (model) => (model.__vendor === "anthropic" ? COMPLEX_DOC : "WRONG VENDOR");
    const [doc] = await condenseDocs(CLIENT, ["competitor-analysis"] as never, { "competitor-analysis": COMPLEX_DOC }, "rules");

    expect(doc.content).toBe(COMPLEX_DOC);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const model = streamTextMock.mock.calls[0]![0].model;
    expect(model.__vendor).toBe("anthropic");
    expect(model.__id).toBe(HIGH_COMPLEXITY_MODEL);
  });

  it("routes an oversized document to Gemini on vendor google", async () => {
    const huge = "## Only section\n\n" + "x".repeat(600_000);
    handleCall = (model) => (model.__vendor === "google" ? huge : "WRONG VENDOR");
    const [doc] = await condenseDocs(CLIENT, ["market-strategy"] as never, { "market-strategy": huge }, "rules");

    expect(doc.content).toBe(huge);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const model = streamTextMock.mock.calls[0]![0].model;
    expect(model.__vendor).toBe("google");
    expect(model.__id).toBe(LARGE_CONTEXT_MODEL);
  });

  it("selects a DIFFERENT model for the high-complexity document than for the standard one — the acceptance-criterion proof, end to end", async () => {
    handleCall = () => SIMPLE_DOC;
    await condenseDocs(CLIENT, ["brand-voice"] as never, { "brand-voice": SIMPLE_DOC }, "rules");
    const simpleModelId = streamTextMock.mock.calls[0]![0].model.__id;

    streamTextMock.mockClear();
    handleCall = () => COMPLEX_DOC;
    await condenseDocs(CLIENT, ["competitor-analysis"] as never, { "competitor-analysis": COMPLEX_DOC }, "rules");
    const complexModelId = streamTextMock.mock.calls[0]![0].model.__id;

    expect(complexModelId).not.toBe(simpleModelId);
    expect(complexModelId).toBe(HIGH_COMPLEXITY_MODEL);
  });
});
