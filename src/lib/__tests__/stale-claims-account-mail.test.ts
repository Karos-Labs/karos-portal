import { beforeEach, describe, expect, it, vi } from "vitest";

import * as userActions from "@/lib/actions/user-actions";
import * as data from "@/lib/data";
import * as auth from "@/lib/auth";
import { emailFrom, sendEmail } from "@/lib/email";

/**
 * QA #150 — THE ACCOUNT-DECISION MAILS, READ AS THE PERSON RECEIVES THEM.
 *
 * `emailShell` was written "for client-facing deliveries" and baked that
 * occasion into its own markup: a "Prepared for <name>" eyebrow and a closing
 * line reading "Reply to this email to request changes — your Karos team is on
 * it." Its only two callers are the approve/decline mails in
 * `lib/actions/user-actions.ts`, so a person who had just been approved — or
 * declined, with their account already deleted — was addressed as the recipient
 * of a deliverable and invited to request changes to something that had never
 * been prepared, under a masthead ("KarosCMO") that did not match the name the
 * mail was sent as.
 *
 * WHAT THIS DRIVES, AND WHY IT IS NOT A UNIT TEST OF THE SHELL. It runs the real
 * `approveRegistrationAction` / `rejectRegistrationAction` and reads the markup
 * they actually hand to `sendEmail`. `@/lib/email` is mocked ONLY at delivery —
 * `emailShell` and the `html` tag stay real — so what is asserted here is the
 * mail, not a shell rendered with arguments a test made up. A shell that is
 * honest in isolation and a caller that passes it a deliverable framing is
 * exactly the bug, and only the joined surface can see it.
 *
 * BOTH OCCASIONS, EVERY RULE. Each assertion below is asked of the approval mail
 * AND the decline mail, because the defect was one sentence that was true of
 * neither and printed on both. Where the two mails must legitimately differ
 * (only one of them offers a way back into the product) that difference is
 * asserted too, so a shell reduced to saying one thing for both occasions fails
 * here rather than passing quietly.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/data");
// Delivery only. `emailShell` and `html` are the code under test here, so unlike
// user-actions.test.ts (which mocks the shell away to ask about role decisions)
// this file must render the real thing.
vi.mock("@/lib/email", async (io) => ({
  ...(await io<typeof import("@/lib/email")>()),
  sendEmail: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/firebase/admin", () => {
  const authApi = {
    createUser: vi.fn().mockResolvedValue({ uid: "u-new" }),
    updateUser: vi.fn().mockResolvedValue(undefined),
    deleteUser: vi.fn().mockResolvedValue(undefined),
  };
  return { adminAuth: () => authApi, adminDb: () => ({}) };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: vi.fn() };
});

const ADMIN = {
  uid: "u-admin",
  name: "Dana Admin",
  email: "dana@karoslabs.com",
  role: "KAROS_ADMIN",
  clientId: null,
};

const PENDING = {
  uid: "u-pending",
  name: "Pat Pending",
  email: "pat@acme.com",
  role: "PENDING",
  clientId: null,
  disabled: true,
  createdAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getCurrentUser).mockResolvedValue(ADMIN as never);
  vi.mocked(data.getUser).mockResolvedValue(PENDING as never);
  vi.mocked(data.upsertUser).mockResolvedValue(undefined as never);
  vi.mocked(data.deleteUser).mockResolvedValue(undefined as never);
});

/** The markup the action really handed to Resend, for one occasion. */
async function mailFor(occasion: "approved" | "declined"): Promise<string> {
  if (occasion === "approved") {
    // KAROS_EMPLOYEE rather than CLIENT_USER: the role decision is another
    // file's subject, and this one needs no client to be created first.
    await userActions.approveRegistrationAction(PENDING.uid, { role: "KAROS_EMPLOYEE" });
  } else {
    await userActions.rejectRegistrationAction(PENDING.uid);
  }
  const calls = vi.mocked(sendEmail).mock.calls;
  expect(calls, `the ${occasion} decision sent no mail at all`).toHaveLength(1);
  return String(calls[0]![0].html);
}

const OCCASIONS = ["approved", "declined"] as const;

/** Rendered text, tags removed and whitespace flattened — what a reader sees. */
const readable = (markup: string) => markup.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

const countOf = (haystack: string, pattern: RegExp) => haystack.match(pattern)?.length ?? 0;

/**
 * Qualified wordmarks only: "Karos Labs", "KarosCMO", "Karos CMO". A bare
 * "Karos" is the product's short name and is used conversationally on both the
 * mail and the portal ("New to Karos?"), so counting it would flag prose rather
 * than branding. Normalised so the spaced and unspaced spellings of one wordmark
 * are one wordmark.
 */
function wordmarks(text: string): Set<string> {
  const found = text.match(/Karos\s*(?:Labs|CMO)\b/g) ?? [];
  return new Set(found.map((m) => m.toLowerCase().replace(/\s+/g, "")));
}

describe("the account-decision mails (QA #150)", () => {
  it("sends one mail per decision, and the two are not the same mail", async () => {
    // Non-vacuity for everything below: if either action stopped mailing, or if
    // both occasions produced identical markup, the rules would hold over
    // nothing or over one mail wearing two names.
    const approved = await mailFor("approved");
    vi.mocked(sendEmail).mockClear();
    const declined = await mailFor("declined");

    expect(readable(approved)).toContain("You're in");
    expect(readable(declined)).toContain("About your Karos Labs request");
    expect(approved).not.toBe(declined);
  });

  it.each(OCCASIONS)("does not address a %s applicant as a deliverable recipient", async (occasion) => {
    const text = readable(await mailFor(occasion));

    // The shell's two hard-coded deliverable claims. Neither person was sent a
    // deliverable: one was given an account, the other was refused one.
    expect(text, "the 'Prepared for <name>' eyebrow is back").not.toMatch(/Prepared for/i);
    expect(text, "invites changes to a deliverable that does not exist").not.toMatch(
      /request changes/i,
    );
  });

  it.each(OCCASIONS)("invites a reply exactly once in the %s mail", async (occasion) => {
    const text = readable(await mailFor(occasion));

    // ONE invitation, printed ONCE. The decline mail's body already offers the
    // reply path ("reply to this email or write to <support>"), so a shell that
    // adds its own closing invitation prints the same offer twice; a mail with
    // none leaves a `replyTo` header nobody is told about. Both are wrong, and a
    // one-sided assertion would only catch one of them.
    expect(countOf(text, /reply to this email/gi)).toBe(1);
  });

  it.each(OCCASIONS)("greets the %s applicant by their own name", async (occasion) => {
    expect(readable(await mailFor(occasion))).toContain(`Hi ${PENDING.name},`);
  });

  it.each(OCCASIONS)("speaks one wordmark in the %s mail, and it is the one on the envelope", async (occasion) => {
    // KEYED TO THE ENVELOPE, NOT TO A FILE. The first version of this read the
    // wordmark off `src/app/login/page.tsx` and called it "the brand this person
    // will meet next" — which is false: an approved CLIENT_USER meets
    // `onboarding-wizard.tsx`, and that screen says "Welcome to Karos CMO". Had
    // the author picked THAT file as the oracle, the same code would have failed.
    // An assertion that passes or fails on which file the author happened to open
    // is not measuring anything; the product carries two wordmarks on its own
    // screens and choosing between them is not this test's business.
    //
    // What IS decidable, and what the recipient actually experiences: the name on
    // the envelope and the name on the masthead are the same name. An inbox shows
    // the sender before the subject, so a mail From "Karos Labs" headed "KarosCMO"
    // contradicts itself in the two lines a person reads first. `emailFrom()` is
    // the real derivation `sendEmail` uses — not a copy of the string — so
    // reverting the From default now fails here instead of shipping green.
    const envelope = wordmarks(emailFrom());
    expect(envelope, "no qualified wordmark on the From line").toHaveProperty("size", 1);

    const mail = wordmarks(readable(await mailFor(occasion)));
    expect(mail, "the mail carries no wordmark at all").toHaveProperty("size", 1);
    // One brand per mail AND the brand it was sent as: a header reading "KarosCMO"
    // over a body that says "Karos Labs" fails on the first count, and a mail that
    // renamed itself consistently away from its own From line fails on the second.
    expect([...mail]).toEqual([...envelope]);
  });

  it("brands a CLIENT_USER approval the same way, and greets them by name", async () => {
    // THE JOURNEY THE OTHER CASES DO NOT WALK. Every test above approves as
    // KAROS_EMPLOYEE because it needs no client created first — but the person
    // #150 is about is a client, and the client branch is the one that creates a
    // workspace and sets `hasCompletedOnboarding`. A shell that is honest for
    // staff and not for clients would pass this file without this case.
    vi.mocked(data.createClient).mockResolvedValue("c-new" as never);
    await userActions.approveRegistrationAction(PENDING.uid, {
      role: "CLIENT_USER",
      newClientName: "Acme Corp",
    });
    const text = readable(String(vi.mocked(sendEmail).mock.calls[0]![0].html));

    expect(text).toContain(`Hi ${PENDING.name},`);
    expect(text, "the deliverable footer is back on a client's account mail").not.toMatch(
      /request changes/i,
    );
    expect([...wordmarks(text)]).toEqual([...wordmarks(emailFrom())]);
  });

  it("still decides the account when the mail cannot be built", async () => {
    // The soft-fail its docstring promises, driven rather than trusted. A user doc
    // with no `name` used to reach `recipientName.trim()` and throw — AFTER the
    // upsert had landed, so the account was already changed and the admin saw an
    // error over a decision that had happened.
    vi.mocked(data.getUser).mockResolvedValue({ ...PENDING, name: undefined } as never);

    await expect(
      userActions.approveRegistrationAction(PENDING.uid, { role: "KAROS_EMPLOYEE" }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(data.upsertUser), "the account decision itself was lost").toHaveBeenCalled();

    // AND THE MAIL STILL GOES OUT. Without this line the test passes on a bare
    // `recipientName.trim()` too, because the try/catch in
    // `notifyRegistrationDecision` swallows the TypeError and the account
    // decision survives either way — so the assertions above cannot tell the two
    // fixes apart. They are not the same outcome for the person: `?? ""` sends
    // them their approval with no greeting, the bare `.trim()` sends them
    // nothing at all and logs it. Someone whose user doc has no name must still
    // be TOLD they were approved.
    expect(
      vi.mocked(sendEmail),
      "a missing name swallowed the whole notification",
    ).toHaveBeenCalledTimes(1);
    const text = readable(String(vi.mocked(sendEmail).mock.calls[0]![0].html));
    expect(text, "an empty greeting rendered as a stray 'Hi ,'").not.toMatch(/\bHi\s*,/);
    expect(text).toContain("You're in");
  });

  it("points an approved applicant at sign-in, and does not point a declined one there", async () => {
    // The occasion difference, asserted so that "make every mail say the same
    // safe thing" is not a way to pass this file. A declined account no longer
    // exists — `rejectRegistrationAction` deletes the Firestore doc and the auth
    // record — so a sign-in link would be the next false promise.
    const approved = await mailFor("approved");
    vi.mocked(sendEmail).mockClear();
    const declined = await mailFor("declined");

    expect(approved).toContain("/login");
    expect(declined).not.toContain("/login");
    // And the declined mail still offers a real human route.
    expect(readable(declined)).toMatch(/mailto:|write to/i);
  });
});
