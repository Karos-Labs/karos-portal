/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientContextDoc, ContextDocTier, ContextDocType } from "@/lib/types";

/**
 * `refreshClientContextDocsAction` re-condenses a client's internal context
 * documents and republishes them as the client tier. When every model attempt
 * fails, or there is no internal document to condense, `condenseOne`
 * (lib/intel/condense.ts) hands back `{ docType, content: "" }`, its "no
 * client-tier copy this run" signal. The action used to upsert those too, so a
 * vendor outage replaced a client's published document with a blank row at a
 * higher version, and `pickDoc` in client-documents.tsx then showed that
 * document to the client as unavailable. The onboarding path
 * (`writeContextDocsFromResearch`) already drops them.
 *
 * Driven through the real action and the real `requireStaff`. The data layer is
 * an in-memory `clientContextDocs` collection that keys and writes the way the
 * real `upsertClientContextDoc` does (clientId + docType + tier, whole-document
 * replace), so "left as it was" is checked on the stored row itself rather than
 * on which mock was called.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/auth");
vi.mock("@/lib/intel", () => ({
  RESEARCH_ENGINE_RULES: "research rules",
  METRICS_RULES: "metrics rules",
  refreshClientCondensedDocs: vi.fn(),
}));
vi.mock("@/lib/telemetry/structured-log", () => ({ logStructured: vi.fn() }));

import { revalidatePath } from "next/cache";
import * as data from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { refreshClientCondensedDocs } from "@/lib/intel";
import { logStructured } from "@/lib/telemetry/structured-log";
import { refreshClientContextDocsAction } from "../intel-actions";

const CLIENT_ID = "c1";

const STAFF = {
  uid: "u-staff",
  email: "staff@karoslabs.test",
  name: "Staff User",
  role: "KAROS_EMPLOYEE",
  disabled: false,
  createdAt: 0,
};

const CLIENT_USER = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Client User",
  role: "CLIENT_USER",
  clientId: CLIENT_ID,
  disabled: false,
  createdAt: 0,
};

const CREATED_AT = Date.UTC(2026, 5, 1);
const PUBLISHED_AT = Date.UTC(2026, 7, 1);
const NOW = Date.UTC(2026, 8, 11);

/** The six client-visible docTypes `refreshClientCondensedDocs` condenses. */
const DOC_TYPES: readonly ContextDocType[] = [
  "brand-voice",
  "market-strategy",
  "competitor-analysis",
  "product-information",
  "branding-guidelines",
  "target-audience",
];

const recondensed = (docType: ContextDocType) => `# ${docType}\n\n## Findings\n\nThe re-condensed copy.`;

/** A client with every document published: an internal twin and a client-tier row per docType. */
function seedStore(): ClientContextDoc[] {
  return DOC_TYPES.flatMap((docType): ClientContextDoc[] => [
    {
      id: `internal-${docType}`,
      clientId: CLIENT_ID,
      docType,
      tier: "internal",
      content: `# ${docType} (internal)\n\n## Findings\n\nThe analyst copy.`,
      version: 2,
      createdAt: CREATED_AT,
      updatedAt: PUBLISHED_AT,
    },
    {
      id: `client-${docType}`,
      clientId: CLIENT_ID,
      docType,
      tier: "client",
      content: `# ${docType}\n\n## Findings\n\nThe published copy the client reads today.`,
      version: 3,
      summary: ["A cached bullet the drawer serves for version 3."],
      summaryVersion: 3,
      createdAt: CREATED_AT,
      updatedAt: PUBLISHED_AT,
    },
  ]);
}

let store: ClientContextDoc[];

const stored = (docType: ContextDocType, tier: ContextDocTier) =>
  store.find((d) => d.clientId === CLIENT_ID && d.docType === docType && d.tier === tier);

const upsertedDocTypes = () =>
  vi.mocked(data.upsertClientContextDoc).mock.calls.map(([doc]) => doc.docType);

const skipLogs = () =>
  vi
    .mocked(logStructured)
    .mock.calls.filter(([, , fields]) => fields?.event === "context_document.refresh_skipped");

/** What the condensation pass hands back: every docType re-condensed, except the ones overridden. */
function condensedAs(overrides: Partial<Record<ContextDocType, string>>) {
  vi.mocked(refreshClientCondensedDocs).mockResolvedValue(
    DOC_TYPES.map((docType) => ({ docType, content: overrides[docType] ?? recondensed(docType) })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  store = seedStore();
  vi.mocked(getCurrentUser).mockResolvedValue(STAFF as any);
  vi.mocked(data.getClient).mockResolvedValue({ id: CLIENT_ID, name: "Acme" } as any);
  vi.mocked(data.listClientContextDocs).mockImplementation(async (clientId, tier) =>
    structuredClone(store.filter((d) => d.clientId === clientId && (!tier || d.tier === tier))),
  );
  vi.mocked(data.upsertClientContextDoc).mockImplementation(async (doc) => {
    const i = store.findIndex(
      (d) => d.clientId === doc.clientId && d.docType === doc.docType && d.tier === doc.tier,
    );
    if (i === -1) store.push({ id: `new-${doc.tier}-${doc.docType}`, ...doc });
    else store[i] = { id: store[i]!.id, ...doc };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshClientContextDocsAction: an empty condensation leaves the published row alone", () => {
  it("keeps the stored client-tier row exactly as it was, cached summary included", async () => {
    // One is condense.ts's own empty signal; the other is whitespace, which is
    // no more readable to a client.
    condensedAs({ "brand-voice": "", "market-strategy": " \n\t " });
    const before = structuredClone(store);

    await refreshClientContextDocsAction(CLIENT_ID);

    expect(stored("brand-voice", "client")).toEqual(before.find((d) => d.id === "client-brand-voice"));
    expect(stored("market-strategy", "client")).toEqual(
      before.find((d) => d.id === "client-market-strategy"),
    );
    expect(upsertedDocTypes()).not.toContain("brand-voice");
    expect(upsertedDocTypes()).not.toContain("market-strategy");
  });

  it("writes nothing at all when every condensation came back empty, and still revalidates", async () => {
    condensedAs(Object.fromEntries(DOC_TYPES.map((docType) => [docType, ""])));
    const before = structuredClone(store);

    await refreshClientContextDocsAction(CLIENT_ID);

    expect(store).toEqual(before);
    expect(data.upsertClientContextDoc).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/clients/${CLIENT_ID}`);
  });

  it("creates no client-tier row for an empty condensation of a document that had none", async () => {
    store = store.filter((d) => !(d.tier === "client" && d.docType === "target-audience"));
    condensedAs({ "target-audience": "" });

    await refreshClientContextDocsAction(CLIENT_ID);

    expect(stored("target-audience", "client")).toBeUndefined();
  });

  it("logs which docTypes it skipped, and logs no skip when it skipped none", async () => {
    condensedAs({ "brand-voice": "", "market-strategy": " \n\t " });
    await refreshClientContextDocsAction(CLIENT_ID);

    expect(skipLogs()).toEqual([
      [
        "WARNING",
        expect.any(String),
        {
          event: "context_document.refresh_skipped",
          clientId: CLIENT_ID,
          docTypes: ["brand-voice", "market-strategy"],
        },
      ],
    ]);

    vi.mocked(logStructured).mockClear();
    condensedAs({});
    await refreshClientContextDocsAction(CLIENT_ID);

    expect(skipLogs()).toEqual([]);
  });
});

describe("refreshClientContextDocsAction: a non-empty condensation still publishes", () => {
  it("upserts the same row as version+1, keeping its original createdAt", async () => {
    condensedAs({ "brand-voice": "" });

    await refreshClientContextDocsAction(CLIENT_ID);

    for (const docType of DOC_TYPES.filter((t) => t !== "brand-voice")) {
      expect(stored(docType, "client"), docType).toMatchObject({
        id: `client-${docType}`,
        content: recondensed(docType),
        version: 4,
        createdAt: CREATED_AT,
        updatedAt: NOW,
      });
    }
    // The internal tier is the condenser's input, never its output.
    for (const docType of DOC_TYPES) {
      expect(stored(docType, "internal"), docType).toMatchObject({ version: 2, updatedAt: PUBLISHED_AT });
    }
  });
});

describe("refreshClientContextDocsAction: authorization", () => {
  it("refuses a client user before condensing or writing anything", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(CLIENT_USER as any);
    condensedAs({});

    await expect(refreshClientContextDocsAction(CLIENT_ID)).rejects.toThrow("Forbidden");

    expect(refreshClientCondensedDocs).not.toHaveBeenCalled();
    expect(data.upsertClientContextDoc).not.toHaveBeenCalled();
  });
});
