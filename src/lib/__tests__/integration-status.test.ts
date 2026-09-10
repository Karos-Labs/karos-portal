import { describe, expect, it } from "vitest";
import { integrationNeedsReconnect, integrationIsUsable } from "../integration-status";

describe("integration-status helpers", () => {
  it("treats active and absent status as usable", () => {
    expect(integrationIsUsable({ status: "active" })).toBe(true);
    expect(integrationIsUsable({ status: undefined })).toBe(true);
    expect(integrationNeedsReconnect({ status: "active" })).toBe(false);
    expect(integrationNeedsReconnect({ status: undefined })).toBe(false);
  });

  it("treats both expired AND reauthenticate as needing reconnect", () => {
    expect(integrationNeedsReconnect({ status: "expired" })).toBe(true);
    expect(integrationNeedsReconnect({ status: "reauthenticate" })).toBe(true);
    expect(integrationIsUsable({ status: "expired" })).toBe(false);
    expect(integrationIsUsable({ status: "reauthenticate" })).toBe(false);
  });
});
