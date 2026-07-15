/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "@/lib/actions/asset-actions";
import * as data from "@/lib/data";
import * as integ from "@/lib/integration-status";
import * as shared from "@/lib/actions/_shared";
import * as auth from "@/lib/auth";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/integration-status");
vi.mock("@/lib/auth");

const NOW = Date.now();

function makeAsset(patch: Record<string, any> = {}): any {
  return {
    id: "a1",
    clientId: "c1",
    type: "social_post",
    title: "Post",
    content: "hi",
    status: "draft",
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  // stub requireStaff to pass
  vi.spyOn(shared, "requireStaff").mockImplementation(async () => ({ id: "u-staff", role: "KAROS_EMPLOYEE", disabled: false, clientId: "c1" } as any));
  // stub getCurrentUser used by requireAssetAccess
  vi.spyOn(auth, "getCurrentUser").mockImplementation(async () => ({ id: "u-staff", role: "KAROS_EMPLOYEE", disabled: false, clientId: "c1" } as any));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("approveAssetAction auto-schedule behavior", () => {
  it("auto-schedules and marks auto when an active integration exists and recommendedAt is present", async () => {
    const asset = makeAsset({ recommendedAt: NOW + 86_400_000, channels: ["linkedin"] });
    (data.getAsset as any).mockResolvedValue(asset);
    (data.listClientIntegrations as any).mockResolvedValue([
      { id: "i1", platform: "linkedin", clientId: "c1", connectedAt: 1 },
    ]);
    (integ.integrationIsUsable as any).mockReturnValue(true);
    // client opted in
    (data.getClientSettings as any).mockResolvedValue({ clientId: "c1", autoScheduleEnabled: true });
    const updated: any[] = [];
    (data.updateAsset as any).mockImplementation(async (id: string, patch: Record<string, any>) => {
      updated.push({ id, patch });
    });

    await actions.approveAssetAction("a1");

    expect(updated.length).toBe(1);
    const patch = updated[0].patch;
    expect(patch).toHaveProperty("status", "approved");
    expect(patch).toHaveProperty("scheduledAt", asset.recommendedAt);
    expect(patch).toHaveProperty("publishMode", "auto");
    expect(patch).toHaveProperty("scheduledPlatform", "linkedin");
  });

  it("falls back to manual if no active integration exists but still calendars the candidate slot", async () => {
    const asset = makeAsset({ recommendedAt: NOW + 86_400_000, channels: ["linkedin"] });
    (data.getAsset as any).mockResolvedValue(asset);
    (data.listClientIntegrations as any).mockResolvedValue([
      { id: "i1", platform: "linkedin", clientId: "c1", connectedAt: 1 },
    ]);
    (integ.integrationIsUsable as any).mockReturnValue(false);
    // client opted in (but integration unusable)
    (data.getClientSettings as any).mockResolvedValue({ clientId: "c1", autoScheduleEnabled: true });
    const updated: any[] = [];
    (data.updateAsset as any).mockImplementation(async (id: string, patch: Record<string, any>) => {
      updated.push({ id, patch });
    });

    await actions.approveAssetAction("a1");

    expect(updated.length).toBe(1);
    const patch = updated[0].patch;
    expect(patch).toHaveProperty("status", "approved");
    expect(patch).toHaveProperty("scheduledAt", asset.recommendedAt);
    expect(patch).toHaveProperty("publishMode", "manual");
    // platform preference still suggested on the calendar for staff reference
    expect(patch).toHaveProperty("scheduledPlatform", "linkedin");
  });

  it("respects client opt-out: even with a usable integration, auto-scheduling is blocked when the client has disabled autoScheduleEnabled", async () => {
    const asset = makeAsset({ recommendedAt: NOW + 86_400_000, channels: ["linkedin"] });
    (data.getAsset as any).mockResolvedValue(asset);
    (data.listClientIntegrations as any).mockResolvedValue([
      { id: "i1", platform: "linkedin", clientId: "c1", connectedAt: 1 },
    ]);
    (integ.integrationIsUsable as any).mockReturnValue(true);
    // client settings show opt-out
    (data.getClientSettings as any).mockResolvedValue({ clientId: "c1", autoScheduleEnabled: false });

    const updated: any[] = [];
    (data.updateAsset as any).mockImplementation(async (id: string, patch: Record<string, any>) => {
      updated.push({ id, patch });
    });

    await actions.approveAssetAction("a1");

    expect(updated.length).toBe(1);
    const patch = updated[0].patch;
    expect(patch).toHaveProperty("status", "approved");
    expect(patch).toHaveProperty("scheduledAt", asset.recommendedAt);
    // Because client opted out, even though integration is usable, publishMode must be manual
    expect(patch).toHaveProperty("publishMode", "manual");
    expect(patch).toHaveProperty("scheduledPlatform", "linkedin");
  });
});
