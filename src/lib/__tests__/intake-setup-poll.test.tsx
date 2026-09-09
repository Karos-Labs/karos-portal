import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * "SETUP IS RUNNING. THIS PAGE UPDATES ITSELF WHEN IT FINISHES." — flow audit
 * 2026-09, R1 (F2) · NN/g *Visibility of System Status*.
 *
 * Four intake surfaces printed that sentence and none of them polled: no
 * interval, no `AutoRefresh`, and one `router.refresh()` fired before the job
 * could have started. A client waited on a dead page for a ~30-minute run.
 *
 * The sentence was also LOCAL-ONLY state: it existed while `fired` was true and
 * vanished on a reload, putting the "Set it up" button back on screen while the
 * run it fires was already in flight — one press away from a second charge for
 * the same stand-up. So the band now reads the server's own in-flight answer as
 * well, and this file asserts both halves of that:
 *
 *  · WHAT THE READER SEES is asked of the render, because that is where the
 *    double-charge lived — a button that must not be there.
 *  · THAT IT POLLS is asked of the source, because `AutoRefresh` renders
 *    `null`: it is an effect, and no markup can show it is mounted.
 *
 * AND THAT IT STOPS. The first cut of this fix held the press as a boolean that
 * was never reset, so a run that FAILED pinned the page for the rest of the
 * session: the sentence stayed, the button never came back, and the poller kept
 * doing a full `router.refresh()` every four seconds against a job that was
 * already over. The rule that ends a press is pure (`fireWindowExpired`) and
 * unit-tested below; that the bands hold their press through it, rather than
 * through a boolean, is asked of the source, because this repo's vitest runs
 * under `environment: "node"` — there is no DOM to let an effect and a timer
 * run in.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { fireWindowExpired, SETUP_FIRE_GRACE_MS } from "@/components/setup-fire-window";
import { BlogAgentIntake } from "@/components/blog-agent-intake";
import { NewsletterAgentIntake } from "@/components/newsletter-agent-intake";
import { ReputationAgentIntake } from "@/components/reputation-agent-intake";
import { LinkedInAgentIntake } from "@/components/linkedin-agent-intake";

const PROMISE = "Setup is running. This page updates itself when it finishes.";

function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

const paint: Record<string, (runInFlight: boolean) => string> = {
  blog: (runInFlight) =>
    renderToStaticMarkup(
      <BlogAgentIntake
        clientId="c1"
        company={{ cmsName: "WordPress" }}
        isSetUp={false}
        runs={[]}
        runInFlight={runInFlight}
        setupCost={10}
        isStaff={false}
      />,
    ),
  newsletter: (runInFlight) =>
    renderToStaticMarkup(
      <NewsletterAgentIntake
        clientId="c1"
        company={{ preferredWeekday: 2 }}
        isSetUp={false}
        feedback={[]}
        runs={[]}
        runInFlight={runInFlight}
        setupCost={10}
        isStaff={false}
      />,
    ),
  reputation: (runInFlight) =>
    renderToStaticMarkup(
      <ReputationAgentIntake
        clientId="c1"
        company={{ reviewSurfaces: ["Google"] }}
        isSetUp={false}
        runs={[]}
        runInFlight={runInFlight}
        setupCost={25}
        isStaff={false}
      />,
    ),
  linkedin: (runInFlight) =>
    renderToStaticMarkup(
      <LinkedInAgentIntake
        clientId="c1"
        company={{ handle: "linkedin.com/company/acme", offLimits: "nothing" }}
        seats={[]}
        news={[]}
        isSetUp={false}
        feedback={[]}
        runs={[]}
        runInFlight={runInFlight}
        setupCost={25}
        isStaff={false}
      />,
    ),
};

/** The setup band's own body, so a match elsewhere in the file cannot pass it. */
function setupBand(file: string): string {
  const src = readFileSync(join(process.cwd(), `src/components/${file}`), "utf8");
  const from = src.indexOf("function SetupBand");
  expect(from, `${file} has a SetupBand`).toBeGreaterThan(-1);
  return src.slice(from, src.indexOf("\n}\n", from));
}

describe.each(Object.keys(paint))("%s's setup band", (family) => {
  const render = paint[family]!;

  it("keeps the promise it makes, with the component that can keep it", () => {
    const band = setupBand(`${family}-agent-intake.tsx`);
    expect(band).toContain(PROMISE);
    expect(band).toContain("<AutoRefresh />");
    // Mounted in the running branch, not unconditionally: a page that polls
    // every four seconds forever is a different defect from one that never does.
    expect(band).toContain("running ? (");
  });

  it("shows the running state to a client who reloads mid-run", () => {
    const text = textOf(render(true));
    expect(text).toContain(PROMISE);
  });

  it("does not offer a second press while that run is in flight", () => {
    // The double-charge: `fired` was local, so a reload re-armed a button whose
    // run was already queued and charged for.
    expect(textOf(render(true))).not.toContain("Set it up");
  });

  it("still offers the press when nothing is running, so this is not vacuous", () => {
    const text = textOf(render(false));
    expect(text).toContain("Set it up");
    expect(text).not.toContain(PROMISE);
  });

  it("gives the button back after a run that failed, and stops polling", () => {
    // A failed (or refused) run is a server that reports nothing in flight. It
    // renders identically to "never fired", which is the point: the press is
    // held in a window that the server's own answer closes, so the failure
    // state has a control in it. The band must not keep its own answer.
    const band = setupBand(`${family}-agent-intake.tsx`);
    const text = textOf(render(false));
    expect(text).toContain("Set it up");
    expect(text).not.toContain(PROMISE);
    // The press cannot be a latch. `useSetupFireWindow` is what expires it;
    // a bare `useState(false)` for it is how the pin came back last time.
    expect(band).toContain("useSetupFireWindow(runInFlight)");
    expect(band).not.toMatch(/useState\(false\)/);
    expect(band).toContain("const running = runInFlight || fired;");
  });
});

describe("a press stops counting once the server has had its say", () => {
  const now = 1_760_000_000_000;

  it("never expires a band that was not pressed", () => {
    expect(fireWindowExpired({ firedAt: null, runInFlight: false, now })).toBe(false);
  });

  it("holds a press the server has not had time to see", () => {
    // The job document is written before dispatch, but only the NEXT server
    // render carries it — this is the second in which a client could otherwise
    // press again and buy a second stand-up.
    expect(
      fireWindowExpired({ firedAt: now - 1_000, runInFlight: false, now }),
    ).toBe(false);
  });

  it("expires a press the server has seen the end of", () => {
    // The failure case: the run is over (or never started), the grace has run
    // out, and the control has to come back.
    expect(
      fireWindowExpired({ firedAt: now - SETUP_FIRE_GRACE_MS, runInFlight: false, now }),
    ).toBe(true);
  });

  it("keeps a press alive for as long as the run actually runs", () => {
    // A stand-up takes ~30 minutes; the window is a handover to the server's
    // fact, not a guess at how long the work takes.
    expect(
      fireWindowExpired({ firedAt: now - 30 * 60_000, runInFlight: true, now }),
    ).toBe(false);
  });

  it("expires it the moment that run stops, however long it ran", () => {
    expect(
      fireWindowExpired({ firedAt: now - 30 * 60_000, runInFlight: false, now }),
    ).toBe(true);
  });
});

describe("a seat's voice build is held by the press alone", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/linkedin-agent-intake.tsx"),
    "utf8",
  );
  const seatSetup = src.slice(src.indexOf("function SeatSetup"), src.indexOf("function RequiredMark"));

  it("uses the same window, so a failed voice run gives the button back", () => {
    expect(seatSetup).toContain("useSetupFireWindow(setupRunInFlight)");
    expect(seatSetup).toContain("<AutoRefresh />");
  });

  it("does not claim a build from the family's in-flight fact alone", () => {
    // Its family IS set up by the time a seat exists, so a run in flight may be
    // an ordinary post run. The server's fact decides how long this reader's
    // press lasts; it never starts the sentence on its own.
    expect(seatSetup).not.toMatch(/running\s*=\s*(setup)?[rR]unInFlight/);
    expect(seatSetup).toContain("{fired ? (");
  });

  it("is held by SETUP runs, not by whatever the family happens to be doing", () => {
    // Review wave, 2026-09: it took the family-wide `runInFlight`, so an
    // ordinary scheduled LinkedIn post kept every seat card's press counting for
    // as long as that post ran. The narrower prop is answered on the server from
    // `runType: "launch"` — see setupRunInFlight in lib/agent-intake-views.ts.
    expect(seatSetup).not.toMatch(/\brunInFlight\b(?!\s*[?:,)])/);
    expect(seatSetup).toContain("setupRunInFlight: boolean;");
  });
});
