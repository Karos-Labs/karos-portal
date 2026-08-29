/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #44 — HTML INJECTION INTO THE STAFF INBOX, FROM A FIELD BOTH SENDERS ASSUMED
 * SAFE.
 *
 * Two hand-written templates for the same mail to the same address, each
 * escaping the one field its author expected to be hostile and interpolating
 * the rest raw. The copilot tool escaped `message` on the very next line while
 * dropping in `client.name` and `user.name ?? user.email`;
 * `sendSupportEmailAction` built a `safeMessage` and then interpolated `name`,
 * `email` AND `subject`. Whoever reads the Karos inbox reads the result as
 * platform-generated.
 *
 * The fix is not "escape those three too" — that fixes today's template and
 * leaves the next author the same question. So the assertions below are about
 * the two devices that make the question stop being asked:
 *
 *   1. the `html` tag escapes EVERY interpolation unless it is itself an `html`
 *      fragment, and there is no exported way to make one of those by hand, and
 *   2. there is now ONE template, so both senders hand over data and never
 *      markup.
 *
 * Every field is driven with a hostile value, individually — a template that
 * escapes three of four is the bug this closes.
 */

const PAYLOAD = '<script>alert("x")</script>';
const ANCHOR = '<a href="https://evil.test">Reset your password</a>';

/* ─────────────────────────── the tag itself ─────────────────────────── */

describe("the html tag", () => {
  it("escapes an interpolated value", async () => {
    const { html } = await import("@/lib/email");
    expect(String(html`<p>${PAYLOAD}</p>`)).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>",
    );
  });

  it("escapes the ampersand too, so an escape cannot be smuggled in pre-encoded", () => {
    // `&lt;script&gt;` typed by the sender must survive as literal text rather
    // than being re-read as a tag by anything downstream that unescapes once.
    return import("@/lib/email").then(({ html }) => {
      expect(String(html`<p>${"&lt;script&gt;"}</p>`)).toBe(
        "<p>&amp;lt;script&amp;gt;</p>",
      );
    });
  });

  it("escapes a value landing in an attribute value", async () => {
    const { html } = await import("@/lib/email");
    expect(String(html`<a href="${'" onmouseover="steal()'}">x</a>`)).not.toContain(
      'onmouseover="steal()"',
    );
  });

  it("does not double-escape a nested fragment", async () => {
    const { html } = await import("@/lib/email");
    const inner = html`<b>${PAYLOAD}</b>`;
    expect(String(html`<p>${inner}</p>`)).toBe(
      "<p><b>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</b></p>",
    );
  });

  it("renders a list of fragments, and nothing for an absent one", async () => {
    const { html } = await import("@/lib/email");
    expect(String(html`${[html`<li>a</li>`, html`<li>b</li>`]}`)).toBe("<li>a</li><li>b</li>");
    expect(String(html`<p>${null}${undefined}</p>`)).toBe("<p></p>");
  });

  it("exports no way to mark a raw string as trusted", async () => {
    // The whole guarantee above rests on the tag being the only constructor.
    // An exported escape hatch is the line this rule would eventually be
    // undone through, so there isn't one.
    const mod: Record<string, unknown> = await import("@/lib/email");
    const escapeHatches = Object.keys(mod).filter((k) => /raw|trusted|unsafe|dangerous/i.test(k));
    expect(escapeHatches).toEqual([]);
  });
});

/* ──────────────────────── the one shared template ──────────────────────── */

describe("supportRequestEmail escapes every field it is handed", () => {
  const FIELDS = [
    ["fromName", (v: string) => ({ fromName: v })],
    ["fromEmail", (v: string) => ({ fromEmail: v })],
    ["subject", (v: string) => ({ subject: v })],
    ["message", (v: string) => ({ message: v })],
  ] as const;

  const BASE = {
    fromName: "Dana",
    fromEmail: "dana@acme.test",
    subject: "Help",
    message: "Nothing works.",
  };

  it.each(FIELDS)("%s", async (_name, patch) => {
    const { supportRequestEmail } = await import("@/lib/email");
    const rendered = String(supportRequestEmail({ ...BASE, ...patch(ANCHOR) }));
    expect(rendered).not.toContain(ANCHOR);
    expect(rendered).toContain("&lt;a href=&quot;https://evil.test&quot;&gt;");
  });

  it("escapes the client name and id the copilot adds", async () => {
    const { supportRequestEmail } = await import("@/lib/email");
    const rendered = String(
      supportRequestEmail({ ...BASE, client: { name: ANCHOR, id: PAYLOAD } }),
    );
    expect(rendered).not.toContain(ANCHOR);
    expect(rendered).not.toContain(PAYLOAD);
  });

  it("still renders the fields as text, so the escaping did not eat the mail", async () => {
    // The other direction: a template that escaped everything into nothing
    // would satisfy every assertion above.
    const { supportRequestEmail } = await import("@/lib/email");
    const rendered = String(
      supportRequestEmail({ ...BASE, client: { name: "Acme", id: "c1" } }),
    );
    for (const text of ["Dana", "dana@acme.test", "Help", "Nothing works.", "Acme", "c1"]) {
      expect(rendered, `dropped ${text}`).toContain(text);
    }
  });

  it("omits the client row entirely when there is no client", async () => {
    const { supportRequestEmail } = await import("@/lib/email");
    expect(String(supportRequestEmail(BASE))).not.toContain(">Client<");
  });
});

/* ───────────────────────── sender 1: the support form ───────────────────────── */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/email", async (io) => ({
  ...(await io<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async () => ({ ok: true, id: "e1" })),
}));

import { getCurrentUser } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { sendSupportEmailAction } from "@/lib/actions/support-actions";

const HOSTILE_USER = {
  uid: "u1",
  name: `Dana ${ANCHOR}`,
  email: `dana+${PAYLOAD}@acme.test`,
  role: "CLIENT_USER",
  clientId: "c1",
  createdAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendSupportEmailAction", () => {
  it("puts no caller-controlled markup in the mail, from any field", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(HOSTILE_USER as any);
    const result = await sendSupportEmailAction({
      subject: `Urgent ${ANCHOR}`,
      message: `Please help ${PAYLOAD}`,
    });
    expect(result).toEqual({ ok: true });

    const sent = vi.mocked(sendEmail).mock.calls[0]![0];
    const rendered = String(sent.html);
    // The three fields this sender interpolated raw, and the one it escaped.
    expect(rendered, "the display name").not.toContain(ANCHOR);
    expect(rendered, "the address").not.toContain(PAYLOAD);
    expect(rendered).not.toMatch(/<script/i);
    expect(rendered).not.toMatch(/<a\s+href="https:\/\/evil\.test"/i);
    // …and the request is still legible to whoever opens it.
    expect(rendered).toContain("Please help");
    expect(sent.subject).toContain("Urgent");
  });

  it("keeps the reply-to on the real address, unescaped — it is a header, not markup", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      ...HOSTILE_USER,
      email: "dana@acme.test",
      name: "Dana",
    } as any);
    await sendSupportEmailAction({ subject: "Help", message: "Nothing works at all." });
    expect(vi.mocked(sendEmail).mock.calls[0]![0].replyTo).toBe("dana@acme.test");
  });
});

/* ───────────────────── sender 2: the copilot's support tool ───────────────────── */

/**
 * Driven through the real route, so what is proved is the tool the model can
 * actually call rather than a copy of its body written here. The route is taken
 * as far as `streamText`, whose `tools` argument is the registry — the same
 * object the model is handed.
 */
vi.mock("next/server", async (io) => {
  const actual = await io<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => fn() };
});
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/client-model-charge", () => ({
  chargeClientModelCall: vi.fn(async () => ({ denied: null, chargedAt: null })),
  refundClientModelCall: vi.fn(),
  refundOnce: vi.fn(() => async () => {}),
}));
vi.mock("@/lib/agent-roster", () => ({
  getClientCustomAgents: vi.fn(async () => []),
  buildAgentCatalog: vi.fn(() => []),
}));
vi.mock("ai", () => ({
  streamText: vi.fn(() => ({ toTextStreamResponse: () => new Response("ok"), stream: null })),
  generateText: vi.fn(),
  generateObject: vi.fn(),
  tool: (t: unknown) => t,
  isLoopFinished: () => () => false,
  stepCountIs: () => () => false,
  // T-B4: the route no longer calls `streamText` itself — it goes through
  // `createChatStreamResponse` (src/lib/chat/stream-protocol.ts), which wraps
  // it in these three. Faked just enough to preserve this test's real point
  // (capturing the `tools` registry `streamText` is called with): the fake
  // `execute`s synchronously, same as the real `createUIMessageStream` does
  // for an `execute` with no top-level `await` before its `streamText` call,
  // so `streamText`'s mock has already recorded its call by the time this
  // file's `toolRegistry()` inspects it.
  createUIMessageStream: ({ execute }: { execute: (o: { writer: unknown }) => unknown }) => {
    const writer = { write: () => {}, merge: () => {}, onError: undefined, setOutcome: () => {} };
    void execute({ writer });
    return new ReadableStream();
  },
  createUIMessageStreamResponse: () => new Response("ok"),
  toUIMessageStream: () => new ReadableStream(),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: Object.assign((id: string) => ({ id }), {
    tools: { webSearch_20250305: () => ({}) },
  }),
}));
// T-B3/SCRUM-246: chat.client's cost-based default now resolves to vendor
// "google" (Gemini) rather than always "anthropic" — see the matching note in
// client-api-access-guard.test.ts.
vi.mock("@ai-sdk/google-vertex", () => ({
  googleVertex: Object.assign((id: string) => ({ id }), { tools: {} }),
}));

import { streamText } from "ai";
import * as data from "@/lib/data";
import * as clientAgentData from "@/lib/data-client-agents";

describe("the copilot's send_support_email tool", () => {
  const STAFF = { uid: "u-admin", name: "Admin", email: "admin@karoslabs.com", role: "KAROS_ADMIN", clientId: null, createdAt: 0 };

  /** Just enough of the workspace for the handler to reach `streamText`. */
  function installWorkspace() {
    vi.mocked(clientAgentData.listClientAgents).mockResolvedValue([]);
    for (const key of [
      "listJobs",
      "listAssets",
      "listClientContextDocs",
      "listClientCompetitors",
      "listClientIntegrations",
      "listContextItems",
    ] as const) {
      vi.mocked(data[key] as any).mockResolvedValue([]);
    }
    vi.mocked(data.getClientReport).mockResolvedValue(null as any);
    vi.mocked(data.getClientCredits).mockResolvedValue(null as any);
    vi.mocked(data.getTaskBoardCapacity).mockResolvedValue({
      activeCount: 0,
      limit: 10,
      atCapacity: false,
    } as any);
    vi.mocked(data.getClientPerformanceBenchmarks).mockResolvedValue({
      top: [],
      bottom: [],
      sampleSize: 0,
    } as any);
  }

  async function toolRegistry(user: unknown) {
    vi.mocked(getCurrentUser).mockResolvedValue(user as any);
    installWorkspace();
    vi.mocked(data.getClient).mockResolvedValue({
      id: "c1",
      name: `Acme ${ANCHOR}`,
      status: "active",
      assignedEmployeeIds: [],
      createdAt: 0,
    } as any);
    const { POST } = await import("@/app/api/clients/[id]/chat/route");
    await POST(
      new Request("http://t/x", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
      { params: Promise.resolve({ id: "c1" }) },
    ).catch(() => null);
    const call = vi.mocked(streamText).mock.calls[0]?.[0] as any;
    return call?.tools as Record<string, { execute: (args: any) => Promise<string> }> | undefined;
  }

  it("sends nothing the caller controls as markup", async () => {
    process.env.ADMIN_EMAIL = "inbox@karoslabs.com";
    const tools = await toolRegistry({ ...STAFF, name: `Admin ${ANCHOR}` });
    expect(tools, "the route never reached streamText — the registry is unreadable").toBeTruthy();
    const support = tools!.send_support_email;
    expect(support, "send_support_email is no longer in the registry").toBeTruthy();

    await support.execute({ subject: `Urgent ${ANCHOR}`, message: `Help ${PAYLOAD}` });

    const sent = vi.mocked(sendEmail).mock.calls[0]![0];
    const rendered = String(sent.html);
    // The client name, the submitter name and the subject — the three this
    // sender interpolated raw — plus the message it did escape.
    expect(rendered, "the client name").not.toContain(ANCHOR);
    expect(rendered, "the message").not.toContain(PAYLOAD);
    expect(rendered).not.toMatch(/<script/i);
    expect(rendered).toContain("Help");
  });

  it("is built from the shared template, not a second copy of it", async () => {
    // Both senders' output carries the branded header the one template renders.
    // If either grows its own markup again, one of these two stops matching.
    process.env.ADMIN_EMAIL = "inbox@karoslabs.com";
    const tools = await toolRegistry(STAFF);
    await tools!.send_support_email.execute({ subject: "Help", message: "Nothing works." });
    const fromTool = String(vi.mocked(sendEmail).mock.calls[0]![0].html);

    vi.mocked(sendEmail).mockClear();
    vi.mocked(getCurrentUser).mockResolvedValue({
      uid: "u1",
      name: "Dana",
      email: "dana@acme.test",
      role: "CLIENT_USER",
      clientId: "c1",
      createdAt: 0,
    } as any);
    await sendSupportEmailAction({ subject: "Help", message: "Nothing works." });
    const fromForm = String(vi.mocked(sendEmail).mock.calls[0]![0].html);

    const MARKER = "&#8250; Support Request";
    expect(fromTool).toContain(MARKER);
    expect(fromForm).toContain(MARKER);
  });
});
