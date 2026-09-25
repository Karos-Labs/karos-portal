import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Client-agent standing feedback on the ENGINE path.
 *
 * The legacy runner received it as a context file. The engine path never sent
 * context files, so an engine-routed agent never saw it at all. It now travels
 * as the `standingFeedback` run input, with the legacy rules intact: live
 * umbrella only, never a launch, active rows only, best-effort.
 */

const { getByKeyMock, listMock } = vi.hoisted(() => ({ getByKeyMock: vi.fn(), listMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data-client-agents", () => ({
  getClientAgentByKey: getByKeyMock,
  listClientAgentFeedback: listMock,
}));

import { standingFeedbackForEngineRun } from "../standing-feedback";

const UMBRELLA = {
  id: "c1__instagram",
  clientId: "c1",
  displayName: "Instagram Agent",
  launchState: "live",
  templates: [{ key: "numbers", name: "By The Numbers" }],
};

function row(patch: Record<string, unknown>) {
  return { id: "f1", status: "active", scope: "agent", templateKey: null, text: "Never use the word synergy.", createdAt: 2, ...patch };
}

beforeEach(() => {
  getByKeyMock.mockReset().mockResolvedValue(UMBRELLA);
  listMock.mockReset().mockResolvedValue([row({}), row({ id: "f2", scope: "template", templateKey: "numbers", text: "One number per slide.", createdAt: 1 })]);
});

describe("standingFeedbackForEngineRun", () => {
  it("renders the live umbrella's active feedback, global first then per template, as the legacy file did", async () => {
    const md = await standingFeedbackForEngineRun({ clientId: "c1", agentKey: "instagram-agent", runType: "recurring" });
    expect(md).toContain("# Client feedback — Instagram Agent");
    expect(md).toContain("Never use the word synergy.");
    expect(md).toContain('Applies only to "By The Numbers"');
    expect(md!.indexOf("synergy")).toBeLessThan(md!.indexOf("One number per slide."));
    expect(listMock).toHaveBeenCalledWith({ clientAgentId: "c1__instagram", status: "active" });
  });

  it("sends nothing on a launch run, for an umbrella that is not live, or when there are no active rows", async () => {
    expect(await standingFeedbackForEngineRun({ clientId: "c1", agentKey: "k", runType: "launch" })).toBeUndefined();
    expect(getByKeyMock).not.toHaveBeenCalled();

    getByKeyMock.mockResolvedValueOnce({ ...UMBRELLA, launchState: "launching" });
    expect(await standingFeedbackForEngineRun({ clientId: "c1", agentKey: "k" })).toBeUndefined();

    getByKeyMock.mockResolvedValueOnce(null);
    expect(await standingFeedbackForEngineRun({ clientId: "c1", agentKey: "k" })).toBeUndefined();

    listMock.mockResolvedValueOnce([]);
    expect(await standingFeedbackForEngineRun({ clientId: "c1", agentKey: "k" })).toBeUndefined();
  });

  it("never throws: a failed read costs the run its feedback, not the run", async () => {
    getByKeyMock.mockRejectedValueOnce(new Error("firestore down"));
    await expect(standingFeedbackForEngineRun({ clientId: "c1", agentKey: "k" })).resolves.toBeUndefined();
  });
});

describe("submit-custom.ts wires it into the engine dispatch", () => {
  const src = readFileSync(join(__dirname, "..", "..", "jobs", "submit-custom.ts"), "utf8");

  it("spreads standingFeedback into the engine run's inputs, after the dialog fields", () => {
    const inputs = src.slice(src.indexOf("dispatchAgentEngineRun({"), src.indexOf("createdBy: user.uid,", src.indexOf("dispatchAgentEngineRun({")));
    expect(inputs).toMatch(/\.\.\.engineExtraInputs,[\s\S]*standingFeedbackInput\(input\.clientId, agent\.key, input\.runType\)/);
  });

  it("does not build the legacy context file for an engine run, which would be uploaded and thrown away", () => {
    expect(src).toMatch(/if \(input\.runType !== "launch" && !engineProductId\) \{\s*try \{\s*const umbrella = await getClientAgentByKey/);
  });
});
