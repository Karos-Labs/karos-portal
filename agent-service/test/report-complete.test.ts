import { describe, expect, it, vi } from "vitest";
import { reportComplete } from "../runner/src/report-complete.js";
import type { ServiceCallback } from "../runner/src/callback.js";

describe("reportComplete", () => {
  it("calls through to callback.complete on success", async () => {
    const complete = vi.fn(async () => undefined);
    await reportComplete({ complete } as unknown as ServiceCallback, { outcome: "done" });
    expect(complete).toHaveBeenCalledWith({ outcome: "done" });
  });

  it("swallows a persistent complete() failure instead of throwing", async () => {
    const complete = vi.fn(async () => {
      throw new Error("service unreachable");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      reportComplete({ complete } as unknown as ServiceCallback, { outcome: "failed", error: "boom" }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "failed to report completion to service after retries:",
      "service unreachable",
    );
    consoleError.mockRestore();
  });
});
