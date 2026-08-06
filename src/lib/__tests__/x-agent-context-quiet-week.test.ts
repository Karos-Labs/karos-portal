/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";

/**
 * Phase 8's explicit backward-compatibility guarantee, pinned.
 *
 * The epic asks, in so many words, to "explicitly confirm the guarantees in
 * `buildXAgentContextFiles` still hold — `whats-new.json` and
 * `takes--<seat-slug>.json` must ALWAYS be delivered, empty
 * (`{"updates": []}` / `{"takes": []}`) on quiet weeks rather than omitted."
 *
 * That guarantee is the difference the X agent uses to tell "the client had
 * nothing to say this week" from "the portal's pipe is broken": an ABSENT file
 * is a broken pipe and the agent should not invent news; a PRESENT file with an
 * empty array is a quiet week and the agent proceeds without a news angle.
 * Nothing in the codebase asserted it before this suite, so the Dynamic Agent
 * Studio work could have regressed it silently — which is exactly the risk the
 * requirement is guarding against.
 *
 * Everything below the data layer is real: the module's own file-assembly
 * logic runs, only Firestore reads and the storage upload are mocked.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data");
vi.mock("@/lib/storage", () => ({
  uploadBytes: vi.fn(async ({ path }: { path: string }) => ({ url: `https://files.test/${path}` })),
}));

const SEAT = {
  id: "seat-1",
  clientId: "c1",
  name: "Dana Levi",
  slug: "dana-levi",
  title: "CEO",
  createdAt: 0,
  updatedAt: 0,
} as any;

/** A client that HAS configured the X agent, but had a completely quiet week. */
function installQuietWeek(overrides: Partial<Record<string, unknown>> = {}) {
  const base: Record<string, unknown> = {
    listClientSeats: [SEAT],
    listAgentIntake: [{ id: "i1", clientId: "c1", agentKey: "x", seatId: null, fields: {}, updatedAt: 0 }],
    listXNewsUpdates: [], // quiet: no company news
    listXTakes: [], // quiet: no takes
    listXDraftFeedback: [],
    listSeatVoiceProfiles: [],
    listJobs: [],
  };
  const merged = { ...base, ...overrides };
  for (const [fn, value] of Object.entries(merged)) {
    (data as any)[fn].mockResolvedValue(value);
  }
  (data.getAgentProfileDocData as any).mockResolvedValue({ company: null, seats: {} });
  (data.getAgentIntake as any).mockResolvedValue(null);
  (data.getAsset as any).mockResolvedValue(null);
}

function names(files: Array<{ name: string }>): string[] {
  return files.map((f) => f.name);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildXAgentContextFiles — the quiet-week guarantee", () => {
  it("delivers whats-new.json on a quiet week, with an EMPTY updates array rather than omitting the file", async () => {
    installQuietWeek();
    const { buildXAgentContextFiles } = await import("@/lib/agent-service/x-agent-context");
    const files = await buildXAgentContextFiles("c1", "X Agent");

    expect(names(files)).toContain("whats-new.json");

    const uploads = (await import("@/lib/storage")).uploadBytes as any;
    const call = uploads.mock.calls.find((c: any[]) => String(c[0].path).endsWith("whats-new.json"));
    expect(call, "whats-new.json was never uploaded").toBeDefined();
    expect(JSON.parse(call[0].bytes.toString("utf8"))).toEqual({ updates: [] });
  });

  it("delivers takes--<seat-slug>.json per configured seat on a quiet week, with an EMPTY takes array", async () => {
    installQuietWeek();
    const { buildXAgentContextFiles } = await import("@/lib/agent-service/x-agent-context");
    const files = await buildXAgentContextFiles("c1", "X Agent");

    expect(names(files)).toContain(`takes--${SEAT.slug}.json`);

    const uploads = (await import("@/lib/storage")).uploadBytes as any;
    const call = uploads.mock.calls.find((c: any[]) => String(c[0].path).endsWith(`takes--${SEAT.slug}.json`));
    expect(call, `takes--${SEAT.slug}.json was never uploaded`).toBeDefined();
    expect(JSON.parse(call[0].bytes.toString("utf8"))).toEqual({ takes: [] });
  });

  it("delivers one takes file per seat, so a second account is never silently dropped", async () => {
    const second = { ...SEAT, id: "seat-2", name: "Noam Bar", slug: "noam-bar" };
    installQuietWeek({ listClientSeats: [SEAT, second] });
    const { buildXAgentContextFiles } = await import("@/lib/agent-service/x-agent-context");
    const files = await buildXAgentContextFiles("c1", "X Agent");
    expect(names(files)).toContain(`takes--${SEAT.slug}.json`);
    expect(names(files)).toContain(`takes--${second.slug}.json`);
  });

  it("still delivers both files when the ONLY thing configured is a seat", async () => {
    installQuietWeek({ listAgentIntake: [] });
    const { buildXAgentContextFiles } = await import("@/lib/agent-service/x-agent-context");
    const files = await buildXAgentContextFiles("c1", "X Agent");
    expect(names(files)).toContain("whats-new.json");
    expect(names(files)).toContain(`takes--${SEAT.slug}.json`);
  });

  it("carries real content through when the week is NOT quiet — the empty case is a floor, not a ceiling", async () => {
    installQuietWeek({
      listXNewsUpdates: [
        { id: "n1", clientId: "c1", title: "Series A closed", body: "We raised.", createdAt: 1, updatedAt: 1 } as any,
      ],
    });
    const { buildXAgentContextFiles } = await import("@/lib/agent-service/x-agent-context");
    await buildXAgentContextFiles("c1", "X Agent");
    const uploads = (await import("@/lib/storage")).uploadBytes as any;
    const call = uploads.mock.calls.find((c: any[]) => String(c[0].path).endsWith("whats-new.json"));
    const parsed = JSON.parse(call[0].bytes.toString("utf8"));
    expect(Array.isArray(parsed.updates)).toBe(true);
    expect(parsed.updates.length).toBe(1);
  });

  it("the whole-file-set gate still applies: a client with NOTHING configured gets no files at all", async () => {
    installQuietWeek({ listClientSeats: [], listAgentIntake: [] });
    const { buildXAgentContextFiles } = await import("@/lib/agent-service/x-agent-context");
    expect(await buildXAgentContextFiles("c1", "X Agent")).toEqual([]);
  });

  it("describes whats-new.json in a way that tells the agent an empty array means a quiet week", async () => {
    installQuietWeek();
    const { buildXAgentContextFiles } = await import("@/lib/agent-service/x-agent-context");
    const files = await buildXAgentContextFiles("c1", "X Agent");
    const whatsNew = files.find((f) => f.name === "whats-new.json");
    // The description is the only place the agent learns how to read an empty
    // array; losing that sentence would make the guarantee unusable even while
    // the file itself kept arriving.
    expect(whatsNew?.description ?? "").toMatch(/quiet week/i);
  });
});
