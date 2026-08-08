import { describe, expect, it } from "vitest";
import { createContextStore, serializeContext, withStepOutput } from "../runner/src/dynamic/context-store.js";

describe("createContextStore", () => {
  it("copies inputs rather than aliasing the caller's object", () => {
    const inputs = { company_name: "Acme" };
    const context = createContextStore(inputs);
    expect(context.inputs).toEqual(inputs);
    expect(context.inputs).not.toBe(inputs);
    inputs.company_name = "mutated";
    expect(context.inputs.company_name).toBe("Acme");
  });

  it("starts with an empty outputs map", () => {
    expect(createContextStore({}).outputs).toEqual({});
  });
});

describe("withStepOutput", () => {
  it("accumulates every step's output under its own stepId, never overwriting earlier ones", () => {
    let context = createContextStore({ topic: "x" });
    context = withStepOutput(context, "research", { summary: "..." });
    context = withStepOutput(context, "draft", "Hello world");
    expect(context.outputs).toEqual({ research: { summary: "..." }, draft: "Hello world" });
  });

  it("returns a new object rather than mutating the one it was given", () => {
    const before = createContextStore({});
    const after = withStepOutput(before, "s1", "out");
    expect(before.outputs).toEqual({});
    expect(after.outputs).toEqual({ s1: "out" });
    expect(after).not.toBe(before);
  });
});

describe("serializeContext", () => {
  it("is deterministic regardless of key insertion order", () => {
    const a = { inputs: { b: "1", a: "2" }, outputs: { y: "1", x: "2" } };
    const b = { outputs: { x: "2", y: "1" }, inputs: { a: "2", b: "1" } };
    expect(serializeContext(a)).toBe(serializeContext(b));
  });

  it("sorts keys at every nested level, not just the top", () => {
    const context = { inputs: {}, outputs: { step1: { z: 1, a: { d: 1, c: 2 } } } };
    const serialized = serializeContext(context);
    expect(serialized.indexOf('"a"')).toBeLessThan(serialized.indexOf('"z"'));
    expect(serialized.indexOf('"c"')).toBeLessThan(serialized.indexOf('"d"'));
  });

  it("round-trips through JSON.parse back to an equal structure", () => {
    const context = { inputs: { name: "Acme" }, outputs: { research: { facts: [1, 2, 3] } } };
    expect(JSON.parse(serializeContext(context))).toEqual(context);
  });
});
