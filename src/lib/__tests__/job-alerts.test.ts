import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmail: sendEmailMock };
});

import { alertRecipients, notifyJobFailure, notifyScheduleFireFailure } from "@/lib/job-alerts";
import type { Client, Job } from "@/lib/types";

const BASE_JOB: Job = {
  id: "job1",
  clientId: "client1",
  agentId: "agent-service",
  agentName: "X Agent",
  title: "Draft a post",
  status: "failed",
  input: {},
  assetIds: [],
  events: [],
  error: "429 rate limit exceeded",
  createdBy: "system",
  createdAt: 1,
  updatedAt: 2,
};

const BASE_CLIENT: Client = {
  id: "client1",
  name: "Acme Co",
  assignedEmployeeIds: [],
  status: "active",
  createdAt: 0,
  createdBy: "system",
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ ok: true, id: "email1" });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("alertRecipients", () => {
  it("returns an empty list when ADMIN_EMAILS is unset", () => {
    delete process.env.ADMIN_EMAILS;
    expect(alertRecipients()).toEqual([]);
  });

  it("splits, trims, and drops empty entries", () => {
    process.env.ADMIN_EMAILS = " a@x.com, b@x.com ,,c@x.com";
    expect(alertRecipients()).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("returns an empty list for a blank string", () => {
    process.env.ADMIN_EMAILS = "   ";
    expect(alertRecipients()).toEqual([]);
  });
});

describe("notifyJobFailure", () => {
  it("does not send when no recipients are configured", async () => {
    delete process.env.ADMIN_EMAILS;
    await notifyJobFailure(BASE_JOB, BASE_CLIENT);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends to every configured recipient with client/agent/job-id and the classified error", async () => {
    process.env.ADMIN_EMAILS = "ops@karoslabs.com";
    await notifyJobFailure(BASE_JOB, BASE_CLIENT);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0]![0];
    expect(call.to).toEqual(["ops@karoslabs.com"]);
    expect(call.subject).toContain("Acme Co");
    expect(call.subject).toContain("X Agent");
    expect(call.html).toContain("job1");
    expect(call.html).toContain("Rate limited by provider");
  });

  it("falls back to the raw clientId when no Client record is available", async () => {
    process.env.ADMIN_EMAILS = "ops@karoslabs.com";
    await notifyJobFailure(BASE_JOB, null);
    const call = sendEmailMock.mock.calls[0]![0];
    expect(call.subject).toContain("client1");
  });

  it("never throws, even when sendEmail itself rejects", async () => {
    process.env.ADMIN_EMAILS = "ops@karoslabs.com";
    sendEmailMock.mockRejectedValue(new Error("network down"));
    await expect(notifyJobFailure(BASE_JOB, BASE_CLIENT)).resolves.toBeUndefined();
  });
});

describe("notifyScheduleFireFailure", () => {
  const OPTS = {
    clientId: "client1",
    clientName: "Acme Co",
    agentLabel: "X Agent",
    scheduleId: "schedule1",
    error: "Agent service is not configured",
  };

  it("does not send when no recipients are configured", async () => {
    delete process.env.ADMIN_EMAILS;
    await notifyScheduleFireFailure(OPTS);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends with the schedule id and raw refusal in the body", async () => {
    process.env.ADMIN_EMAILS = "ops@karoslabs.com";
    await notifyScheduleFireFailure(OPTS);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0]![0];
    expect(call.to).toEqual(["ops@karoslabs.com"]);
    expect(call.subject).toContain("Acme Co");
    expect(call.html).toContain("schedule1");
    expect(call.html).toContain("Agent service is not configured");
  });

  it("never throws, even when sendEmail itself rejects", async () => {
    process.env.ADMIN_EMAILS = "ops@karoslabs.com";
    sendEmailMock.mockRejectedValue(new Error("network down"));
    await expect(notifyScheduleFireFailure(OPTS)).resolves.toBeUndefined();
  });
});
