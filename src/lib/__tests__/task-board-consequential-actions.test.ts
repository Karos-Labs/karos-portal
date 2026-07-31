/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "@/lib/data";
import * as dataClientAgents from "@/lib/data-client-agents";
import * as auth from "@/lib/auth";
import * as engine from "@/lib/execution-engine";

/**
 * The two controls on the client task board that a client can press by accident
 * and cannot undo: the trash icon (deleted the task on one click, no dialog) and
 * the green "Run Agent" button (charged the client's credits with no figure
 * shown anywhere and no chance to stop). A drag into In Progress was the same
 * charge by another route.
 *
 * The gate is a UI gate by design — the server authorization is correct, and a
 * client passing it is ENTITLED to delete and to run, so nothing downstream will
 * ever stop a misclick. The price half of it is server-priced, so that half is
 * driven for real here; the confirmation wiring itself is asserted from the
 * source, whitespace-normalised, in the style of credits-ux.test.ts.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/lib/data");
vi.mock("@/lib/data-client-agents");
vi.mock("@/lib/auth");
vi.mock("@/lib/execution-engine", () => ({
  inferOwnerEngine: vi.fn(),
  plannedTaskExecutionCost: vi.fn(),
  runTaskExecution: vi.fn(),
  resolveTaskType: vi.fn(() => "content_generation"),
  runAutopilotBatch: vi.fn(),
  runClaimedTasks: vi.fn(),
  dispatchArtifactEmail: vi.fn(),
}));

/** A real client user: role CLIENT_USER, no impersonatedBy ⇒ billable. */
const CLIENT = {
  uid: "u-client",
  email: "client@acme.test",
  name: "Client User",
  role: "CLIENT_USER",
  disabled: false,
  clientId: "c1",
  createdAt: 0,
} as any;

/** An admin in "View as Client": reads as CLIENT_USER, is never charged. */
const IMPERSONATED = { ...CLIENT, impersonatedBy: "u-admin" };

const STAFF = { ...CLIENT, uid: "u-staff", role: "KAROS_EMPLOYEE", clientId: null };

const CUSTOM_AGENT_ID = "ca-instagram";

/** The price the engine reports for this task — nothing about it is a constant. */
const PLANNED_COST = 17;

function makeTask(patch: Record<string, any> = {}): any {
  return {
    id: "t1",
    clientId: "c1",
    title: "Instagram post for launch week",
    status: "pending",
    owner: "karos_managed",
    priority: "medium",
    source: "copilot",
    metadata: { customAgentId: CUSTOM_AGENT_ID },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function umbrella(launchState: string) {
  return {
    id: "ca1",
    clientId: "c1",
    agentKey: "karos-instagram-agent",
    customAgentId: CUSTOM_AGENT_ID,
    displayName: "Instagram agent",
    launchState,
    templates: [],
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (auth.getCurrentUser as any) = vi.fn().mockResolvedValue(CLIENT);
  (auth.requireUser as any) = vi.fn().mockResolvedValue(CLIENT);
  (engine.inferOwnerEngine as any).mockReturnValue("karos_managed");
  (engine.plannedTaskExecutionCost as any).mockResolvedValue(PLANNED_COST);
  (data.getClientTask as any).mockResolvedValue(makeTask());
  (data.getClient as any).mockResolvedValue({ id: "c1", name: "Acme" });
  (data.getCustomAgent as any).mockResolvedValue({
    id: CUSTOM_AGENT_ID,
    key: "karos-instagram-agent",
    name: "Instagram agent",
    enabled: true,
  });
  (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella("live"));
});

describe("previewTaskRunAction — the price a client is shown before the charge", () => {
  it("quotes the figure the charge path would take, straight from the engine", async () => {
    const { previewTaskRunAction } = await import("@/lib/actions/task-actions");

    const res = await previewTaskRunAction("t1", "c1");

    expect(res).toEqual({ ok: true, credits: PLANNED_COST, billable: true });
    // The same function updateTaskStatusAction charges with — not a UI constant.
    expect(engine.plannedTaskExecutionCost).toHaveBeenCalledTimes(1);
  });

  it("follows the engine when the price changes, rather than a hardcoded number", async () => {
    (engine.plannedTaskExecutionCost as any).mockResolvedValue(25);
    const { previewTaskRunAction } = await import("@/lib/actions/task-actions");

    expect(await previewTaskRunAction("t1", "c1")).toMatchObject({ credits: 25 });
  });

  it("claims nothing, charges nothing, runs nothing — it is a preview", async () => {
    const { previewTaskRunAction } = await import("@/lib/actions/task-actions");

    await previewTaskRunAction("t1", "c1");

    expect(data.claimTaskForExecution).not.toHaveBeenCalled();
    expect(data.chargeClientCredits).not.toHaveBeenCalled();
    expect(engine.runTaskExecution).not.toHaveBeenCalled();
    expect(data.updateClientTask).not.toHaveBeenCalled();
  });

  it("reports not-billable for staff, so no price confirmation is raised", async () => {
    (auth.getCurrentUser as any).mockResolvedValue(STAFF);
    const { previewTaskRunAction } = await import("@/lib/actions/task-actions");

    const res = await previewTaskRunAction("t1", "c1");

    expect(res).toEqual({ ok: true, credits: 0, billable: false });
    // Not even priced: staff runs are agency overhead, so there is no figure.
    expect(engine.plannedTaskExecutionCost).not.toHaveBeenCalled();
  });

  it("reports not-billable for an admin viewing as the client", async () => {
    // This session's role IS "CLIENT_USER" — only the server can tell, which is
    // why the browser asks instead of deciding.
    (auth.getCurrentUser as any).mockResolvedValue(IMPERSONATED);
    const { previewTaskRunAction } = await import("@/lib/actions/task-actions");

    expect(await previewTaskRunAction("t1", "c1")).toEqual({
      ok: true,
      credits: 0,
      billable: false,
    });
  });

  it("prices a client-owned move at nothing — that status change is free", async () => {
    (engine.inferOwnerEngine as any).mockReturnValue("client_managed");
    (data.getClientTask as any).mockResolvedValue(makeTask({ owner: "client_managed" }));
    const { previewTaskRunAction } = await import("@/lib/actions/task-actions");

    expect(await previewTaskRunAction("t1", "c1")).toEqual({
      ok: true,
      credits: 0,
      billable: false,
    });
    expect(engine.plannedTaskExecutionCost).not.toHaveBeenCalled();
  });

  it("gives the §2 refusal instead of a price when the agent is not live yet", async () => {
    (dataClientAgents.getClientAgentByKey as any).mockResolvedValue(umbrella("curating"));
    const { previewTaskRunAction } = await import("@/lib/actions/task-actions");

    const res = await previewTaskRunAction("t1", "c1");

    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(res.credits).toBeUndefined();
  });

  it("refuses a task that is not this client's, like every other task action", async () => {
    (data.getClientTask as any).mockResolvedValue(makeTask({ clientId: "c2" }));
    const { previewTaskRunAction } = await import("@/lib/actions/task-actions");

    expect(await previewTaskRunAction("t1", "c1")).toEqual({
      ok: false,
      error: "This task no longer exists.",
    });
  });
});

/* ── The board's own wiring ───────────────────────────────────────── */

const REPO = path.resolve(__dirname, "../..", "..");
const source = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

const BOARD_PATH = "src/components/tasks-board.tsx";
const board = source(BOARD_PATH);

/** The body of a named function declared inside the component/module. */
function functionBody(src: string, declaration: string): string {
  const open = src.indexOf(declaration);
  expect(open, `no ${declaration} in ${BOARD_PATH}`).toBeGreaterThan(-1);
  const close = src.indexOf("\n  }", open);
  expect(close).toBeGreaterThan(open);
  return src.slice(open, close);
}

describe("the delete control cannot reach deleteTaskAction on one click", () => {
  it("the trash icon arms a question instead of deleting", () => {
    expect(flat(board)).toContain("onClick={() => setConfirmingDelete(true)}");
    // The pre-fix wiring: the icon called the delete handler straight out.
    expect(board).not.toContain("onClick={onDelete}");
  });

  it("has exactly one onDelete call site, and it is the confirmed branch", () => {
    const sites = board.match(/onDelete\(\)/g) ?? [];
    expect(sites).toHaveLength(1);
    expect(flat(board)).toContain("setConfirmingDelete(false); onDelete();");
  });

  it("names the task being deleted, in sentence case", () => {
    expect(flat(board)).toContain("Delete &ldquo;{task.title}&rdquo;? This cannot be undone.");
  });

  it("offers a way out that touches nothing but the confirm state", () => {
    expect(board).toContain("Yes, delete it");
    expect(board).toContain("Keep it");
    // Cancelling clears the flag and calls no action — the board is untouched.
    expect(flat(board)).toContain("onClick={() => setConfirmingDelete(false)}");
  });

  it("renders the question outside the hover-only action row", () => {
    // A confirm that disappears when the pointer leaves the card is not a
    // confirm: it must sit above the `group-hover:flex` row, like the error and
    // executing banners do.
    const confirm = board.indexOf("{confirmingDelete && (");
    const hoverRow = board.indexOf("group-hover:flex");
    expect(confirm).toBeGreaterThan(-1);
    expect(confirm).toBeLessThan(hoverRow);
  });

  it("still reaches deleteTaskAction once confirmed — the gate is a gate, not a block", () => {
    const handleDelete = functionBody(board, "function handleDelete(");
    expect(handleDelete).toContain("deleteTaskAction(task.id, task.clientId)");
  });
});

describe("a billable run is price-gated; a free status move is not", () => {
  const gate = functionBody(board, "function chargesCredits(");
  const request = functionBody(board, "function requestStatusChange(");

  it("gates on the same condition the server charges on", () => {
    // If these two ever disagree the board either gates a free move or lets a
    // charge through unannounced.
    const server = flat(source("src/lib/actions/task-actions.ts"));
    expect(server).toContain('status === "in_progress" && inferOwnerEngine(task) === "karos_managed"');
    expect(flat(gate)).toContain('nextStatus === "in_progress" && inferOwner(task) === "karos_managed"');
  });

  it("asks for a price before committing a charging move", () => {
    expect(flat(request)).toContain("if (isClientViewer && chargesCredits(task, nextStatus))");
    expect(flat(request)).toContain("askToRunTask(task);");
  });

  it("commits every other move straight away — no friction on a free move", () => {
    // The else path is the untouched original call, so "Start" on client-owned
    // work behaves exactly as it did.
    expect(flat(request)).toContain("commitStatusChange(task, nextStatus, fallbackSnapshot);");
  });

  it("routes the card button through the gate, not at the action", () => {
    expect(flat(board)).toContain("onMoveTask={(task, nextStatus) => requestStatusChange(task, nextStatus)}");
    expect(flat(board)).not.toContain("onMoveTask={(task, nextStatus) => commitStatusChange(task, nextStatus)}");
  });

  it("prices the run server-side rather than computing credits in the browser", () => {
    const ask = functionBody(board, "function askToRunTask(");
    expect(ask).toContain("previewTaskRunAction(task.id, task.clientId)");
    expect(flat(ask)).toContain('setRunPrompt({ taskId: task.id, credits: res.credits ?? 0 });');
    // Nothing is committed on the asking pass except when there is no charge.
    expect(ask).not.toContain("updateTaskStatusAction");
  });

  it("only charges from the confirm handler", () => {
    const confirm = functionBody(board, "function confirmTaskRun(");
    expect(confirm).toContain('commitStatusChange(task, "in_progress")');
    expect(flat(confirm)).toContain("setRunPrompt(null);");
  });
});

describe("the drag into In Progress meets the same gate", () => {
  const dragEnd = functionBody(board, "function handleDragEnd(");

  it("ends in the gate, not in the charge", () => {
    expect(dragEnd).toContain("requestStatusChange(previousTask, targetStatus, snapshot)");
    expect(dragEnd).not.toContain("commitStatusChange(");
  });

  it("puts the card back where it was while the question is open", () => {
    // handleDragOver has already moved it optimistically; a confirm that leaves
    // the card in the In Progress column implies a run that has not happened.
    const request = functionBody(board, "function requestStatusChange(");
    expect(flat(request)).toContain("if (fallbackSnapshot) setLocalTasks(fallbackSnapshot);");
  });

  it("gates the ticket-modal footer move too, so no third door charges silently", () => {
    expect(flat(board)).toContain("requestStatusChange(current, status as BoardStatus);");
  });
});

describe("staff gain no friction from a client's price confirmation", () => {
  it("keys the gate on the viewer's role, which is now load-bearing", () => {
    expect(board).toContain('const isClientViewer = currentUserRole === "CLIENT_USER";');
    // The prop used to be discarded with `void currentUserRole`.
    expect(board).not.toContain("void currentUserRole");
  });

  it("does not even price a staff run — no confirm, no round trip", () => {
    const request = functionBody(board, "function requestStatusChange(");
    expect(flat(request)).toContain("if (isClientViewer && chargesCredits(task, nextStatus))");
  });

  it("releases an impersonated admin on the server's own verdict", () => {
    const ask = functionBody(board, "function askToRunTask(");
    expect(flat(ask)).toContain('if (!res.billable) { commitStatusChange(task, "in_progress"); return; }');
  });
});

describe("the confirm copy states a real credit figure", () => {
  const panel = board.slice(board.indexOf("{runPrompt && ("), board.indexOf("{/* Actions only take space"));

  it("states the number it was handed, not a vague warning", () => {
    expect(panel).toContain("Runs this task now for ");
    expect(panel).toContain("${runPrompt.credits} credit${runPrompt.credits === 1 ? \"\" : \"s\"}");
    expect(flat(panel)).not.toMatch(/costs? credits/i);
    expect(flat(panel)).not.toMatch(/some credits/i);
  });

  it("hardcodes no figure of its own", () => {
    // Every digit in the panel belongs to a class name; none belongs to a price.
    expect(panel).not.toMatch(/\d+\s+credits?\b/);
  });

  it("puts the price on the button that spends, matching the batch panel", () => {
    expect(panel).toContain("Run & charge ${runPrompt.credits}");
    // The batch runner's confirm, verbatim, is the pattern being copied.
    expect(board).toContain("`Run & charge ${preview.credits} credits`");
  });

  it("never calls credits tokens, and offers a cancel", () => {
    expect(panel.toLowerCase()).not.toContain("token");
    expect(panel).toContain("Cancel");
    expect(flat(board)).toContain("onCancelRun={() => setRunPrompt(null)}");
  });
});
