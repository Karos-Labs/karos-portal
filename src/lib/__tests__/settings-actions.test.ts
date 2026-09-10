/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as settingsActions from "@/lib/actions/settings-actions";
import * as data from "@/lib/data";
import * as auth from "@/lib/auth";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth");

beforeEach(() => {
  vi.resetAllMocks();
});

describe("updateAutoScheduleAction", () => {
  it("persists the opt-in when user authorized", async () => {
    (auth.requireUser as any).mockResolvedValue({ id: "u1", role: "KAROS_ADMIN", clientId: null });
    const upserts: any[] = [];
    (data.upsertClientSettings as any).mockImplementation(async (clientId: string, patch: Record<string, any>) => {
      upserts.push({ clientId, patch });
    });

    const res = await settingsActions.updateAutoScheduleAction("c1", true);
    expect(res.ok).toBe(true);
    expect(upserts.length).toBe(1);
    expect(upserts[0].clientId).toBe("c1");
    expect(upserts[0].patch).toHaveProperty("autoScheduleEnabled", true);
  });

  it("forbids a client user toggling another client", async () => {
    (auth.requireUser as any).mockResolvedValue({ id: "u2", role: "CLIENT_USER", clientId: "c2" });
    const res = await settingsActions.updateAutoScheduleAction("c1", true);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Forbidden");
  });
});
