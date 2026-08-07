/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as data from "@/lib/data";
import * as storage from "@/lib/storage";
import * as shared from "@/lib/actions/_shared";
import { removeClientSeatAction } from "@/lib/actions/client-seat-actions";
import {
  insideAnyRange,
  isStringDelimiter,
  matchingBrace,
  skipStringLiteral,
  stripComments,
} from "./source-scan";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data");
vi.mock("@/lib/storage");

/**
 * #84: a seat could be added and never removed — and it was not cosmetic.
 *
 * `AddSeatForm` on the X and LinkedIn intake pages created ClientSeat rows and no
 * delete existed anywhere in the product. A seat with no intake document still
 * gets a row in the agent page's "What it runs on" band BY DESIGN (that is the
 * band's whole point: "who has never filled theirs in"), so a typo or a departed
 * colleague permanently painted an "Empty" warning badge and permanently inflated
 * the "n of m still empty" line under it.
 *
 * WHAT THIS FILE PINS is the ORDER and the TOTALITY of the removal, because both
 * are invisible at the call site and both are how a removal leaves rubbish
 * behind:
 *
 *  • across EVERY intake family, not just the page the button was on — a seat is
 *    the person, and the add forms say so;
 *  • the private CV object with it, or that person's resume outlives the row that
 *    pointed at it;
 *  • the seat row LAST, so a failure part-way leaves something the client can
 *    still see and press again.
 *
 * And what it deliberately does NOT remove: the draft-feedback log. Those rows
 * are what the agent learns from, and deleting a programme's history to remove
 * one person is a bigger act than the one the client asked for.
 */

const REPO = path.resolve(__dirname, "../..", "..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const SEAT = {
  id: "seat-1",
  clientId: "c1",
  name: "Maya Cohen",
  slug: "maya-cohen",
  createdBy: "u1",
  createdAt: 0,
  updatedAt: 0,
};

/** Every write the action performed, in the order it performed them. */
let order: string[];

function intakeDoc(patch: Record<string, any>) {
  return {
    id: "i-x",
    clientId: "c1",
    agent: "x",
    seatId: "seat-1",
    handle: "@maya",
    offLimits: "nothing",
    roster: [],
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  order = [];
  vi.spyOn(shared, "requireClientAccess").mockImplementation(
    async () => ({ uid: "u1", role: "CLIENT_USER", clientId: "c1", disabled: false }) as any,
  );
  (data.getClientSeat as any).mockResolvedValue(SEAT);
  (data.listAgentIntake as any).mockResolvedValue([]);
  (data.deleteAgentIntake as any).mockImplementation(async (id: string) => {
    order.push(`intake:${id}`);
  });
  (data.deleteXTakesForSeat as any).mockImplementation(async () => {
    order.push("takes");
    return 3;
  });
  (data.deleteClientSeat as any).mockImplementation(async (id: string) => {
    order.push(`seat:${id}`);
  });
  (storage.deleteObject as any).mockImplementation(async (p: string) => {
    order.push(`object:${p}`);
  });
});

describe("removeClientSeatAction", () => {
  it("reaches EVERY intake family, not only the page the button was on", async () => {
    // The client pressed Remove on the X page; the person's LinkedIn answers
    // hang off the same seat row and would otherwise survive it, listed by the
    // other agent's page as answers the client believes they deleted.
    (data.listAgentIntake as any).mockImplementation(async (_c: string, agent: string) =>
      agent === "reddit" ? [] : [intakeDoc({ id: `i-${agent}`, agent })],
    );

    const result = await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });

    expect(result).toEqual({ removedName: "Maya Cohen" });
    const families = (data.listAgentIntake as any).mock.calls.map((c: any[]) => c[1]).sort();
    // FOUR families now. Newsletter has no per-seat concept — an issue goes out
    // from the company, never from a person — so this sweep will always find
    // nothing there. It is visited anyway, and that is the point of the test: the
    // sweep's job is to leave no orphan behind, and "there are none" is cheaper to
    // prove by looking than to assume. A family omitted from the Record in
    // client-seat-actions.ts is a compile error, and this is its runtime twin.
    expect(families).toEqual(["blog", "linkedin", "newsletter", "reddit", "reputation", "x"]);
    expect(order).toContain("intake:i-x");
    expect(order).toContain("intake:i-linkedin");
  });

  it("leaves another seat's documents alone", async () => {
    (data.listAgentIntake as any).mockImplementation(async (_c: string, agent: string) => [
      intakeDoc({ id: `i-${agent}`, agent }),
      intakeDoc({ id: `other-${agent}`, agent, seatId: "seat-2" }),
    ]);

    await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });

    // The fixture hands every family a seat-1 document, newsletter included, so
    // all four are deleted here. What the test is actually pinning is unchanged:
    // only the seat being removed is touched, and the `other-*` documents on
    // seat-2 survive.
    expect(order.filter((o) => o.startsWith("intake:")).sort()).toEqual([
      "intake:i-blog",
      "intake:i-linkedin",
      "intake:i-newsletter",
      "intake:i-reddit",
      "intake:i-reputation",
      "intake:i-x",
    ]);
  });

  it("deletes the private CV object with the document that pointed at it", async () => {
    const CV = "clients/c1/linkedin-agent/cv/maya-1.pdf";
    (data.listAgentIntake as any).mockImplementation(async (_c: string, agent: string) =>
      agent === "linkedin" ? [intakeDoc({ id: "i-li", agent, cvPath: CV })] : [],
    );

    await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });

    // PRESENCE BEFORE ORDER, and it is not pedantry. This used to be the
    // ordering line alone — and `indexOf` answers -1 for a call that never
    // happened, which is less than every real index. So deleting the
    // `deleteObject` call outright left this test green, and nothing else in
    // this file required it to be called at all: the whole remedy on the
    // LinkedIn side (a departed person's resume left in the bucket with nothing
    // pointing at it) could be removed silently.
    expect(storage.deleteObject, "the CV object was never deleted").toHaveBeenCalledWith(CV);
    const objectAt = order.indexOf(`object:${CV}`);
    const docAt = order.indexOf("intake:i-li");
    expect(objectAt, "the CV object was never deleted").toBeGreaterThan(-1);
    expect(docAt, "the intake document was never deleted").toBeGreaterThan(-1);
    // Object first: deleting the doc first would lose the only pointer to it.
    // Both indexes are now known to be real, so this cannot pass on absences.
    expect(objectAt).toBeLessThan(docAt);
  });

  it("still removes the seat when the CV object cannot be deleted", async () => {
    (data.listAgentIntake as any).mockImplementation(async (_c: string, agent: string) =>
      agent === "linkedin" ? [intakeDoc({ id: "i-li", agent, cvPath: "gone.pdf" })] : [],
    );
    (storage.deleteObject as any).mockRejectedValue(new Error("404 no such object"));

    const result = await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });

    // A bucket object that has already gone must not strand the row: the
    // Firestore delete removes the only pointer the product has to it either
    // way. It does NOT mean the bytes went — see the action's own note.
    expect(result.error).toBeUndefined();
    expect(order).toContain("seat:seat-1");
  });

  it("drops the seat row LAST", async () => {
    (data.listAgentIntake as any).mockImplementation(async (_c: string, agent: string) => [
      intakeDoc({ id: `i-${agent}`, agent, cvPath: agent === "linkedin" ? "cv.pdf" : undefined }),
    ]);

    await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });

    expect(order[order.length - 1]).toBe("seat:seat-1");
    // Everything else really did run before it, so "last" is a claim about a
    // populated sequence rather than about a list of one.
    expect(order.length).toBeGreaterThan(3);
  });

  it("takes that person's takes with them, so no count outlives the seat", async () => {
    await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });
    expect(data.deleteXTakesForSeat).toHaveBeenCalledWith("c1", "seat-1");
  });

  it("never touches the draft-feedback log", async () => {
    await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });
    // The learning log is keyed by `account`, which may be a seat id. Deleting
    // it would silently rewrite what the agent knows about the whole programme.
    const logWriters = Object.keys(data).filter(
      (name) => /DraftFeedback/.test(name) && typeof (data as any)[name]?.mock === "object",
    );
    // Non-vacuity: this sweep is only worth anything if it found the writers.
    expect(logWriters.length, "found no draft-feedback functions to check").toBeGreaterThan(2);
    for (const name of logWriters) {
      expect((data as any)[name], name).not.toHaveBeenCalled();
    }
  });

  it("refuses a seat belonging to another client, and writes nothing", async () => {
    (data.getClientSeat as any).mockResolvedValue({ ...SEAT, clientId: "other" });

    const result = await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });

    expect(result.error).toBeTruthy();
    expect(order).toEqual([]);
    expect(data.deleteClientSeat).not.toHaveBeenCalled();
  });

  it("says the same thing for a seat that is gone and one that is not yours", async () => {
    // A client probing ids must not learn which seats exist elsewhere.
    (data.getClientSeat as any).mockResolvedValue(null);
    const missing = await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });
    (data.getClientSeat as any).mockResolvedValue({ ...SEAT, clientId: "other" });
    const foreign = await removeClientSeatAction({ clientId: "c1", seatId: "seat-1" });
    expect(missing.error).toBe(foreign.error);
    // Client copy, not an HTTP word.
    expect(missing.error).not.toMatch(/forbidden|unauthorized|not found/i);
  });

  it("authorizes before it reads anything", async () => {
    (shared.requireClientAccess as any).mockRejectedValue(new Error("Forbidden"));
    await expect(
      removeClientSeatAction({ clientId: "c1", seatId: "seat-1" }),
    ).rejects.toThrow(/Forbidden/);
    expect(data.getClientSeat).not.toHaveBeenCalled();
  });
});

/* ──────────────────── the gesture: two steps, one confirm ───────────────── */

const TAG = "<ClientSeatRemove";

/**
 * Every `<ClientSeatRemove … />` element in `src`, each sliced from its own `<`
 * to the `>` that closes THAT element. Brace expressions are skipped whole, so
 * a `>` inside one (`onDone={() => …}`) cannot end an element early, and string
 * literals go through the shared skip.
 *
 * WHY THE ELEMENT AND NOT THE FILE. `runInFlight={runInFlight}` occurs TWICE in
 * each intake surface — once forwarding the value into `<SeatCard>`, once on
 * this mount — so `expect(src).toContain("runInFlight={runInFlight}")` was
 * satisfied by whichever came first, which is the forward. Both mounts could be
 * changed to `runInFlight={false}` with four test files and 67 assertions
 * green: the warning would simply never appear, on either page, for anyone.
 */
function seatRemoveElements(src: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf(TAG); at !== -1; at = src.indexOf(TAG, at + TAG.length)) {
    // `<ClientSeatRemoveSomethingElse` is a different component.
    if (/[A-Za-z0-9_$]/.test(src[at + TAG.length] ?? "")) continue;
    for (let i = at + TAG.length; i < src.length; i++) {
      const ch = src[i]!;
      if (isStringDelimiter(ch)) {
        i = skipStringLiteral(src, i);
        continue;
      }
      if (ch === "{") {
        const close = matchingBrace(src, i);
        if (close === -1) break;
        i = close;
        continue;
      }
      if (ch === ">") {
        out.push(src.slice(at, i + 1));
        break;
      }
    }
  }
  return out;
}

/**
 * The character ranges each `footer={…}` prop expression spans, brace-matched
 * from its own `{`.
 *
 * CONTAINMENT, NOT PROXIMITY. What this replaces was
 * `/footer=\{[\s\S]{0,400}<ClientSeatRemove/`, which asserts only that the two
 * strings sit within 400 characters of each other. Moving the whole mount out
 * of the footer and down into the Edit-collapsed body left it green — and that
 * is precisely the regression the component's own comment names: "a seat added
 * by mistake is one nobody has opened, and hiding the way back behind Edit is
 * how it became permanent".
 */
function footerRanges(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of src.matchAll(/footer=\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchingBrace(src, open);
    if (close > open) out.push([open, close]);
  }
  return out;
}

describe("#84 — the remove control cannot fire on the first click", () => {
  const code = () => stripComments(read("src/components/client-seat-remove.tsx"));

  it("puts the destructive call behind the confirming state", () => {
    const src = code();
    // The unconfirmed branch is an early return; everything in it must be
    // inert. The pattern is linkedin-seats-workspace.tsx's, where the remove
    // used to fire on the first click of a 16px trash icon.
    const at = src.indexOf("if (!confirming)");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, matchingBrace(src, src.indexOf("{", at)));
    expect(block).not.toContain("removeClientSeatAction");
    expect(block).not.toMatch(/onClick=\{\s*remove\b/);
    expect(block).toContain("setConfirming(true)");
  });

  it("names the consequence the client cannot see from this page", () => {
    const src = read("src/components/client-seat-remove.tsx");
    // A seat is shared across agents, so removing it from the X page removes
    // their LinkedIn answers too. Saying "remove this seat" alone would be
    // technically true and materially misleading.
    expect(src).toMatch(/shared by every agent/i);
    expect(src).toMatch(/cannot be undone/i);
    // A run already submitted has its own copy of the payload and no recall
    // channel, so the confirm says so rather than implying otherwise.
    expect(src).toMatch(/runInFlight/);
    expect(src).toMatch(/may still come back with/i);
    // A3/A4: the shipping unit is not the client's business. The three intake
    // surfaces are already held to this and this component renders inside two
    // of them, so it is held to it here rather than escaping through the file
    // list of the sweep next door.
    expect(stripComments(src), "says 'batch' to the client").not.toMatch(/\bbatch/i);
  });

  it("can tell a mount inside the footer from one outside it", () => {
    // The two source readers the next test leans on, asked to answer NO. A
    // containment check that cannot fail is the thing being replaced here.
    const inside = `<Card footer={<><SeatCv /><ClientSeatRemove seatId={s.id} /></>}><p /></Card>`;
    const outside = `<Card footer={<><SeatCv /></>}><ClientSeatRemove seatId={s.id} /></Card>`;
    expect(insideAnyRange(footerRanges(inside), inside.indexOf(TAG))).toBe(true);
    expect(insideAnyRange(footerRanges(outside), outside.indexOf(TAG))).toBe(false);
    // …and the prop is read off the ELEMENT. This fixture is the exact shape
    // that fooled the old file-wide `toContain`: the forward into <SeatCard>
    // carries the identifier while the mount itself is hard-wired off.
    const decoy = `<SeatCard runInFlight={runInFlight} />\n<ClientSeatRemove\n  seatId={s.id}\n  runInFlight={false}\n/>`;
    expect(decoy).toContain("runInFlight={runInFlight}");
    expect(seatRemoveElements(decoy)).toHaveLength(1);
    expect(seatRemoveElements(decoy)[0]).not.toContain("runInFlight={runInFlight}");
  });

  it("is mounted on both surfaces that create seats, in the footer, wired to the real flag", () => {
    for (const family of ["x", "linkedin"] as const) {
      const src = stripComments(read(`src/components/${family}-agent-intake.tsx`));
      const mounts = seatRemoveElements(src);
      expect(mounts, family).toHaveLength(1);
      // Asked of the MOUNT: the identifier occurs twice in this file and the
      // other occurrence is the <SeatCard> forward, which is not this control.
      expect(mounts[0], family).toContain("runInFlight={runInFlight}");
      expect(mounts[0], family).toContain("seatId={seat.id}");
      // Not behind the collapse: a seat added by mistake is one nobody opened.
      expect(
        insideAnyRange(footerRanges(src), src.indexOf(TAG)),
        `${family}: the remove control is not inside a footer={…} expression`,
      ).toBe(true);
    }
  });

  it("is NOT mounted on the surface with no seat model", () => {
    // Reddit runs on the company account alone; a remove control there would
    // promise a per-person product that does not exist.
    expect(read("src/components/reddit-agent-intake.tsx")).not.toContain("ClientSeatRemove");
  });
});

/* ───────────── #83: two seat rosters, and neither may be nameless ───────── */

describe("#83 — each seat roster says which one it is", () => {
  const workspace = () => read("src/components/linkedin-seats-workspace.tsx");

  it("stops calling itself a third name, in Title Case, inside its own dialog", () => {
    // Asked of the CODE: the comments record what the copy used to say, which is
    // exactly the text being forbidden, and a scan of the raw file would flag
    // the note explaining the fix.
    const code = stripComments(workspace());
    expect(code).not.toContain("Company Employee Roster");
    expect(code).not.toContain("Add Employee Seat");
    // The name its own trigger and dialog already use.
    expect(code).toContain("Employee seats");
    expect(code).toContain("Add employee seat");
  });

  it("shouts no stored status word at the client", () => {
    // `{seat.status.toUpperCase()}` printed the enum itself, in capitals.
    expect(stripComments(workspace())).not.toContain("status.toUpperCase()");
    expect(workspace()).toContain("SEAT_STATUS_LABEL");
  });

  it("says what its count counts, since the other roster counts nobody here", () => {
    const src = workspace();
    expect(src).toMatch(/signed in with LinkedIn/i);
    expect(src).toMatch(/not counted here/i);
  });

  it("says the same thing from the other side, on the agent's own page", () => {
    // The two surfaces read different collections and cannot see each other's
    // rows, so a client who reads only one of them still has to be able to tell
    // which is which — and only one of them has a limit and a price.
    const src = read("src/components/linkedin-agent-intake.tsx");
    expect(src).toMatch(/These seats are who the agent writes for/i);
    expect(src).toMatch(/employee seats list in your settings/i);
    expect(src).toMatch(/only it has a plan limit/i);
  });
});
