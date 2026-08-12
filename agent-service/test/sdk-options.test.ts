import { describe, expect, it } from "vitest";
import { buildStepAgentDefinitions, sdkEnv } from "../runner/src/sdk-options.js";

/**
 * These two helpers were moved out of main.ts (which ends in `void main()` and
 * therefore can't be imported) so the dynamic step runner could reuse the same
 * options plumbing. This suite pins the moved behaviour so the extraction
 * stays a pure move.
 */
describe("buildStepAgentDefinitions", () => {
  it("returns undefined for a missing or empty map, so `...(x ? {agents:x} : {})` stays absent", () => {
    expect(buildStepAgentDefinitions(undefined)).toBeUndefined();
    expect(buildStepAgentDefinitions({})).toBeUndefined();
  });

  it("emits one AgentDefinition per named step, carrying that step's model at low effort", () => {
    const agents = buildStepAgentDefinitions({ research: "claude-sonnet-4-6" });
    expect(agents).toBeDefined();
    expect(Object.keys(agents ?? {})).toEqual(["research"]);
    const research = agents?.research;
    expect(research?.model).toBe("claude-sonnet-4-6");
    expect(research?.effort).toBe("low");
    expect(typeof research?.description).toBe("string");
    expect(typeof research?.prompt).toBe("string");
  });

  it("keeps every entry independent when several steps are routed", () => {
    const agents = buildStepAgentDefinitions({ a: "claude-haiku-4-5-20251001", b: "claude-opus-4-8" });
    expect(agents?.a?.model).toBe("claude-haiku-4-5-20251001");
    expect(agents?.b?.model).toBe("claude-opus-4-8");
  });
});

describe("sdkEnv", () => {
  it("never forwards the runner token", () => {
    const prior = process.env.JOB_SPEC_B64;
    process.env.JOB_SPEC_B64 = "secret-spec";
    try {
      expect(sdkEnv().JOB_SPEC_B64).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.JOB_SPEC_B64;
      else process.env.JOB_SPEC_B64 = prior;
    }
  });

  it("never forwards the spec reference pointer either", () => {
    const prior = process.env.JOB_SPEC_REF_B64;
    process.env.JOB_SPEC_REF_B64 = "secret-ref";
    try {
      expect(sdkEnv().JOB_SPEC_REF_B64).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.JOB_SPEC_REF_B64;
      else process.env.JOB_SPEC_REF_B64 = prior;
    }
  });

  it("forwards an allowlisted variable when it is set, and omits it when it is not", () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      expect(sdkEnv().ANTHROPIC_API_KEY).toBe("sk-test");
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prior;
    }
    const priorApify = process.env.APIFY_TOKEN;
    delete process.env.APIFY_TOKEN;
    try {
      expect("APIFY_TOKEN" in sdkEnv()).toBe(false);
    } finally {
      if (priorApify !== undefined) process.env.APIFY_TOKEN = priorApify;
    }
  });

  it("never forwards an arbitrary non-allowlisted variable", () => {
    process.env.SOME_UNRELATED_SECRET = "nope";
    try {
      expect(sdkEnv().SOME_UNRELATED_SECRET).toBeUndefined();
    } finally {
      delete process.env.SOME_UNRELATED_SECRET;
    }
  });
});
