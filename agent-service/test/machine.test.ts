import { describe, expect, it } from "vitest";
import { InvalidTransition, isTerminal, transition } from "../src/state/machine.js";
import type { JobStatus } from "../src/types.js";

const ctx = { attempt: 1, maxAttempts: 2 };

describe("job state machine", () => {
  it("runs the happy path", () => {
    expect(transition("queued", { type: "start" }, ctx)).toBe("running");
    expect(transition("running", { type: "complete" }, ctx)).toBe("done");
  });

  it("cancels from queued and running", () => {
    expect(transition("queued", { type: "cancel" }, ctx)).toBe("cancelled");
    expect(transition("running", { type: "cancel" }, ctx)).toBe("cancelled");
  });

  it("requeues transient failures while attempts remain", () => {
    expect(transition("running", { type: "fail", transient: true }, { attempt: 1, maxAttempts: 2 })).toBe("queued");
  });

  it("dead-letters transient failures when attempts are exhausted", () => {
    expect(transition("running", { type: "fail", transient: true }, { attempt: 2, maxAttempts: 2 })).toBe(
      "dead_letter",
    );
  });

  it("fails permanently on non-transient failures regardless of attempts", () => {
    expect(transition("running", { type: "fail", transient: false }, { attempt: 1, maxAttempts: 2 })).toBe("failed");
  });

  it("treats timeouts as transient", () => {
    expect(transition("running", { type: "timeout" }, { attempt: 1, maxAttempts: 2 })).toBe("queued");
    expect(transition("running", { type: "timeout" }, { attempt: 2, maxAttempts: 2 })).toBe("dead_letter");
  });

  it("rejects transitions out of terminal states", () => {
    const terminals: JobStatus[] = ["done", "failed", "cancelled", "dead_letter"];
    for (const status of terminals) {
      expect(isTerminal(status)).toBe(true);
      expect(() => transition(status, { type: "start" }, ctx)).toThrow(InvalidTransition);
      expect(() => transition(status, { type: "cancel" }, ctx)).toThrow(InvalidTransition);
      expect(() => transition(status, { type: "complete" }, ctx)).toThrow(InvalidTransition);
    }
  });

  it("rejects nonsensical transitions", () => {
    expect(() => transition("queued", { type: "complete" }, ctx)).toThrow(InvalidTransition);
    expect(() => transition("running", { type: "start" }, ctx)).toThrow(InvalidTransition);
  });
});
