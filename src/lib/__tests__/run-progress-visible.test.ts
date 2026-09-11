import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALL_RUN_OUTCOMES,
  ALL_RUN_OUTCOME_KEYS,
  runOutcome,
  runOutcomeSentence,
  runProgressUrl,
} from "@/lib/run-progress";
import { JOB_STATUS_META } from "@/lib/job-status-copy";
import { matchingBrace, stripComments } from "./source-scan";

/**
 * SCRUM-416: a reader who starts a run can see what stage it is at, and can
 * still see it after they close the dialog.
 *
 * WHAT WAS THERE. The `if (started)` branch of `RunCustomAgentModal`: a
 * `CircleCheck`, the word "started", `RUN_ESTIMATE_SENTENCE`, a staff-only
 * "Open the run" link and a Done button. Lola: "I got the 30-minute popup, but
 * how do I know where it goes, if it worked, etc." An estimate is a PROMISE,
 * and a promise with no progress beside it is the one thing a reader cannot
 * check.
 *
 * THE TWO HALVES THIS FILE HOLDS.
 *
 *  1. The PURE half: which statuses mean wait, look, or nothing-is-coming, and
 *     the sentence for each. Driven directly.
 *  2. The ASSEMBLY half: read from source, because it is a claim about where
 *     the parts are MOUNTED, and mounting is exactly what was missing. A
 *     component that renders progress perfectly and is mounted only inside a
 *     modal answers Lola's question for thirty seconds.
 *
 * WHAT IT DOES NOT CLAIM. It does not render the dock (no DOM here) and it does
 * not test the poller's timing. The route's authorization is not asserted here
 * either - `client-api-access-guard.test.ts` owns every API route's fence and
 * this route is filed in it, which is a stronger place for that claim than a
 * second copy of it would be.
 */

const SRC = path.resolve(__dirname, "../..");
const code = (rel: string) => stripComments(readFileSync(path.join(SRC, rel), "utf8"));

/* ─────────────────────── which statuses mean what ─────────────────────── */

describe("the outcome register", () => {
  it("answers for every run state the job-status register knows", () => {
    // The two registers are keyed by the same union, so this is the check that
    // a new JobStatus cannot be added on one side only. `Record<JobStatus, …>`
    // makes it a compile error too; this is the runtime half, and it fails
    // loudly rather than at the next `tsc`.
    expect([...ALL_RUN_OUTCOME_KEYS].sort()).toEqual(Object.keys(JOB_STATUS_META).sort());
    expect(ALL_RUN_OUTCOME_KEYS.length).toBeGreaterThan(5);
  });

  it("treats review as LANDED, not as still running", () => {
    // The deliverables exist from `review` onward; what is outstanding is a
    // human looking at them. Calling it "working" would leave a client watching
    // a spinner over finished work for as long as the review took.
    expect(runOutcome("review")).toBe("landed");
    expect(runOutcome("approved")).toBe("landed");
    expect(runOutcome("delivered")).toBe("landed");
  });

  it("treats held as stopped, because from the reader's side nothing arrived", () => {
    // `held` is a guardrail doing its job and wears a neutral tone in the
    // status register - which is about how ALARMED to be, not about whether
    // anything came out. Nothing came out.
    expect(runOutcome("held")).toBe("stopped");
    expect(runOutcome("failed")).toBe("stopped");
    expect(runOutcome("cancelled")).toBe("stopped");
  });

  it("calls a status nothing recognises WORKING", () => {
    // Firestore holds strings the union does not. The alternative defaults are
    // both lies a reader would act on: "landed" sends them looking for output
    // that does not exist, "stopped" tells them to start over on a run that is
    // still going.
    expect(runOutcome("something-new")).toBe("working");
    expect(runOutcome("")).toBe("working");
  });
});

/* ────────────────────────────── the sentences ────────────────────────────── */

describe("the sentence under the strip", () => {
  it("says something different to each viewer, for every outcome", () => {
    for (const outcome of ALL_RUN_OUTCOMES) {
      const client = runOutcomeSentence(outcome, true);
      const staff = runOutcomeSentence(outcome, false);
      expect(client.length).toBeGreaterThan(20);
      expect(staff.length).toBeGreaterThan(20);
      // AF-9: the client's line tells the reader their Karos team will look at
      // it, which to the Karos team is a machine telling them to wait for
      // themselves.
      expect(client, outcome).not.toBe(staff);
    }
  });

  it("tells the reader that closing it does not stop the run", () => {
    // The sentence a reader needs before they will believe a dismissible
    // widget. Without it, "Done" reads like "cancel".
    for (const viewerIsClient of [true, false]) {
      expect(runOutcomeSentence("working", viewerIsClient)).toMatch(/does not stop/);
    }
  });

  it("promises a client no destination for work still in review", () => {
    // THE PHANTOM, which this epic removed once already (#415, "the review
    // queue"). A client has nowhere to open a deliverable in `review`: the
    // archive holds APPROVED work only (F149). Naming a place here would send
    // them to an empty page.
    const landed = runOutcomeSentence("landed", true);
    expect(landed).not.toMatch(/archive|Workspace|Assets|Jobs|calendar/i);
    // And no review (Albert, 2026-09-10: the SOW rule stands — a client is never
    // told about the review step). This assertion used to REQUIRE the word.
    expect(landed).not.toMatch(/review|approv/i);
  });

  it("names no stored status and reads as client copy", () => {
    // The recorded product-owner ruling on em dashes and spaced hyphens, and
    // the register rule: a client sentence never prints the database's word.
    const stored = Object.keys(JOB_STATUS_META);
    for (const outcome of ALL_RUN_OUTCOMES) {
      const sentence = runOutcomeSentence(outcome, true);
      expect(sentence).not.toContain("—");
      expect(sentence).not.toMatch(/ - /);
      for (const word of stored) {
        expect(sentence.toLowerCase(), `${outcome} names the stored "${word}"`).not.toMatch(
          new RegExp(`\\b${word}\\b`),
        );
      }
    }
  });
});

describe("the endpoint", () => {
  it("is spelled in one place, and the route file is where it points", () => {
    expect(runProgressUrl("j1")).toBe("/api/runs/j1/progress");
    // The URL builder and the route's own folder have to agree, and nothing
    // else can check that: a moved folder leaves the builder pointing at a 404.
    expect(() =>
      readFileSync(path.join(SRC, "app/api/runs/[id]/progress/route.ts"), "utf8"),
    ).not.toThrow();
  });
});

/* ───────────────────── the assembly: what is mounted where ──────────────── */

describe("the run dialog's started panel", () => {
  const dialog = code("components/custom-agents.tsx");
  /**
   * THE `if (started)` BLOCK, not the file. custom-agents.tsx is 3,600 lines
   * and holds several confirmation panels - the staff "Test run" modal still
   * uses the centred tick layout, correctly, and a file-wide match for it
   * reported that as this panel not having changed.
   */
  const panel = (() => {
    const at = dialog.indexOf("if (started) {");
    expect(at, "the started branch has been renamed").toBeGreaterThan(-1);
    const open = dialog.indexOf("{", at);
    return dialog.slice(open, matchingBrace(dialog, open) + 1);
  })();

  it("was sliced, so the assertions below are reading the right panel", () => {
    expect(panel.length).toBeGreaterThan(500);
    // `<Shell`, not `<Modal`: the same panel is drawn in the page when the run
    // form is (`const Shell = inline ? InlinePanel : Modal`). This line is the
    // marker that the slice found the started panel, and it still is one.
    expect(panel).toContain("<Shell open onClose={onClose}");
  });

  it("is no longer a dead end: it shows the ladder and the outcome sentence", () => {
    expect(panel).toContain("<AgentRunProgress");
    expect(panel).toContain("runOutcomeSentence(outcome, viewerIsClient)");
    // The tick that WAS the whole panel, and the centred layout it anchored.
    expect(panel).not.toContain("CircleCheck");
    expect(panel).not.toContain("text-center");
  });

  it("promises no duration: the moving bar answers how long", () => {
    // It kept "It usually takes …" as context beside the ladder. Albert,
    // 2026-09-10: every "ready in X minutes" is untrue — so none, anywhere here.
    expect(panel).not.toMatch(/RUN_ESTIMATE|usually takes|minutes/);
  });

  it("registers the run with the shell's watch rather than polling itself", () => {
    // One poller per run. When the dialog polled for itself, a reader who left
    // it open behind the dock had two intervals on one job.
    expect(dialog).toContain("watchRun({");
    // One run, not the whole store: an idle form must not re-render on every
    // tick of some other run.
    expect(dialog).toContain("useRunWatchActions()");
    expect(dialog).toContain("useWatchedRun(");
    expect(dialog).not.toContain("setInterval");
    expect(panel).not.toContain("fetch(");
  });

  it("sends each reader to a surface that will actually show them the run", () => {
    // Staff get the run. A client gets Home, because SCRUM-417's "Generated
    // today" widget is the first surface that shows them a deliverable still in
    // review - `/jobs` is staff-gated and the archive holds APPROVED work only
    // (F149), so both of the obvious answers were the phantom-destination
    // defect this epic keeps finding.
    expect(dialog).toMatch(/href: viewerIsClient/);
    expect(dialog).toMatch(/`\/clients\/\$\{selectedClientId\}`/);
    expect(dialog).toMatch(/`\/jobs\/\$\{result\.jobId\}`/);
  });
});

describe("the agent page's other ways to start a run", () => {
  it("hand the run to the same watch, a format's Run now included", () => {
    // Create was watched and each format's Run now was not, so a per-format
    // run vanished from sight the moment the reader left the page.
    const panel = code("components/client-agents/agent-detail-panel.tsx");
    const rows = code("components/client-agents/live-card.tsx");
    expect(panel).toContain("watchRun({");
    expect(panel).toContain("if (result.jobId) watchStarted(result.jobId);");
    expect(panel).toContain("onRunStarted={watchStarted}");
    expect(rows).toContain("if (result.jobId) onRunStarted?.(result.jobId);");
  });
});

describe("the dock", () => {
  const layout = code("app/(app)/layout.tsx");
  const dock = code("components/run-progress-dock.tsx");

  it("is mounted in BOTH shells, which is what makes the progress persistent", () => {
    // The load-bearing claim of the whole ticket. A dock that renders correctly
    // and is mounted nowhere is the modal-only implementation again.
    expect(layout).toContain("<RunProgressDock viewerIsClient />");
    expect(layout).toContain("<RunProgressDock viewerIsClient={false} />");
    expect((layout.match(/<RunProgressDock/g) ?? []).length).toBe(2);
  });

  it("renders nothing when there is nothing in flight", () => {
    // A client with no run must not pay for an empty widget or a poll.
    // `shown`, not `runs`: a run whose own page is on screen is drawn there by
    // the run form, so the dock renders nothing for it either.
    expect(dock).toContain("if (shown.length === 0) return null;");
  });

  it("sits under a modal, so re-opening the dialog is not covered by it", () => {
    // Modal's own layer is z-50 (components/modal.tsx).
    expect(dock).toMatch(/\bz-40\b/);
    expect(dock).not.toMatch(/\bz-(50|\[?[6-9]\d)/);
  });

  it("takes its words from the registers, spelling no run state itself", () => {
    for (const word of Object.values(JOB_STATUS_META).map((m) => m.label)) {
      expect(dock, `the dock spells "${word}" itself`).not.toContain(`"${word}"`);
    }
    expect(dock).toContain("runOutcomeSentence(outcome, viewerIsClient)");
  });

  it("dismisses rather than cancels, and says so", () => {
    // Cancelling is a refund decision and lives on the agent page, where the
    // rules are painted. A control that stops the WATCHING must not read as one
    // that stops the run.
    expect(dock).toContain("Stop showing this");
    expect(dock).not.toContain("CancelRunControl");
  });
});
