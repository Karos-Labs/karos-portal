import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `uploadBytes` had no timeout of any kind — a plain `fetch` with no
 * AbortSignal. A storage endpoint that accepts the connection and then never
 * responds would hang until the *platform* killed the request, which is how the
 * agent-service webhook lost deliverables mid-flight (finding #45).
 *
 * Both tests ask the closed question — "does the call end?" — never the open one
 * ("was a signal passed?"). Under the loosening they forbid (dropping the
 * signal) the promise never settles and each fails.
 *
 * Neither test names the default budget: the number stays in storage.ts. The
 * second one advances a fake clock until the call settles, so it outlasts
 * whatever storage.ts chose.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({
  adminBucketName: () => "test-bucket",
  getAdminAccessToken: async () => "test-token",
}));

import { uploadBytes } from "@/lib/storage";

/** A server that accepts the request and then goes silent forever. */
function silentServer() {
  return vi.fn().mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })),
        );
      }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("uploadBytes is bounded", () => {
  it("rejects instead of hanging when the remote never responds", async () => {
    vi.stubGlobal("fetch", silentServer());

    await expect(
      uploadBytes({
        bytes: Buffer.from("payload"),
        path: "agent-service/job-1/abc-DRAFTS.md",
        contentType: "text/markdown",
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("rejects on its own default budget when the caller names none", async () => {
    // Every other caller in the app (logos, avatars, context files, PDFs) passes
    // no budget, so the default is what actually protects them.
    vi.useFakeTimers();
    // AbortSignal.timeout runs on a Node-internal clock that vi's fake timers do
    // not drive (verified: a faked advance past the delay never fires the abort).
    // Re-express it on the faked global setTimeout so the deadline storage.ts
    // chose is reachable in a test — the delay still comes from storage.ts.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(((ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () =>
          controller.abort(
            Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
          ),
        ms,
      );
      return controller.signal;
    }) as typeof AbortSignal.timeout);
    vi.stubGlobal("fetch", silentServer());

    let outcome: "resolved" | "rejected" | null = null;
    void uploadBytes({
      bytes: Buffer.from("payload"),
      path: "clients/c1/logo.png",
      contentType: "image/png",
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    // Advance until the call settles. 10 fake minutes outlasts any plausible
    // default; if the signal is ever dropped, nothing settles and this runs out.
    for (let elapsed = 0; elapsed < 600_000 && outcome === null; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(outcome).toBe("rejected");
  });
});
