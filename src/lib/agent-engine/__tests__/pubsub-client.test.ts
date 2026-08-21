import { vi, describe, expect, it } from "vitest";

// Must be hoisted before any import that transitively pulls in server-only
vi.mock("server-only", () => ({}));

import { agentEngineRunIdFromMessageId, isAgentEnginePubSubConfigured } from "../pubsub-client";

describe("isAgentEnginePubSubConfigured", () => {
  it("is false with neither AGENT_ENGINE_PUBSUB_TOPIC nor an emulator configured", () => {
    expect(isAgentEnginePubSubConfigured({})).toBe(false);
  });

  it("is true once AGENT_ENGINE_PUBSUB_TOPIC is set", () => {
    expect(isAgentEnginePubSubConfigured({ AGENT_ENGINE_PUBSUB_TOPIC: "karos-agent-runs-prep" })).toBe(true);
  });

  it("treats an empty string the same as unset", () => {
    expect(isAgentEnginePubSubConfigured({ AGENT_ENGINE_PUBSUB_TOPIC: "" })).toBe(false);
  });
});

describe("agentEngineRunIdFromMessageId", () => {
  it("matches agent-engine's own runId derivation exactly (apps/agent-server/src/queue-consumer.ts and routes/queue.ts: `pubsub-${message.id}`)", () => {
    expect(agentEngineRunIdFromMessageId("123456789")).toBe("pubsub-123456789");
  });
});
