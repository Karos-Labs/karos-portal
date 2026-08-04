import { describe, expect, it } from "vitest";
import { taskIsDisabled, TASK_PAUSED_MESSAGE, TASK_AGENT_UNAVAILABLE_MESSAGE } from "@/lib/task-disable-copy";

describe("taskIsDisabled", () => {
  it("is false when metadata.disabled is absent", () => {
    expect(taskIsDisabled({ metadata: {} })).toBe(false);
    expect(taskIsDisabled({ metadata: undefined })).toBe(false);
  });

  it("is false for a falsy or non-boolean value, true only for the literal true", () => {
    expect(taskIsDisabled({ metadata: { disabled: false } })).toBe(false);
    expect(taskIsDisabled({ metadata: { disabled: "true" as unknown as boolean } })).toBe(false);
    expect(taskIsDisabled({ metadata: { disabled: true } })).toBe(true);
  });
});

describe("copy", () => {
  it("carries no internal jargon a client would not recognize", () => {
    for (const message of [TASK_PAUSED_MESSAGE, TASK_AGENT_UNAVAILABLE_MESSAGE]) {
      expect(message).not.toMatch(/disabled|enabled/i);
    }
  });
});
