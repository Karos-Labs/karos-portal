"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardTitle, Button, Select } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  startManagedAgentRunAction,
  getManagedAgentRunAction,
  sendManagedAgentMessageAction,
} from "@/lib/actions";

const POLL_MS = 4000;

/**
 * Staff trigger for the Claude-platform Instagram/TikTok Content Agent.
 * Lives on the Agents page: staff pick a client, start a session, and the
 * card polls its output inline. The agent pauses mid-loop to present
 * drafts — the reply box resumes it (approve, request changes, …), so the
 * card behaves like a lightweight conversation.
 */
export function ManagedAgentLauncher({ clients }: { clients: Array<{ id: string; name: string }> }) {
  const [clientId, setClientId] = useState(clients.length === 1 ? clients[0].id : "");
  const [instructions, setInstructions] = useState("");
  const [reply, setReply] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastTool, setLastTool] = useState<string | undefined>();
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!sessionId || !running) return;
    timer.current = setInterval(async () => {
      try {
        const snap = await getManagedAgentRunAction(sessionId);
        setMessages(snap.messages);
        setLastTool(snap.lastTool);
        if (snap.error) setError(snap.error);
        if (snap.done) setRunning(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to poll the agent run");
        setRunning(false);
      }
    }, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [sessionId, running]);

  async function run() {
    if (!clientId) return;
    setError(null);
    setMessages([]);
    setLastTool(undefined);
    setRunning(true);
    try {
      const result = await startManagedAgentRunAction({
        clientId,
        instructions: instructions || undefined,
      });
      if (typeof result.error === "string" || !result.sessionId) {
        setError(result.error ?? "Failed to start the agent");
        setRunning(false);
        return;
      }
      setSessionId(result.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the agent");
      setRunning(false);
    }
  }

  async function sendReply() {
    if (!sessionId || !reply.trim()) return;
    setError(null);
    const result = await sendManagedAgentMessageAction(sessionId, reply);
    if (typeof result.error === "string") {
      setError(result.error);
      return;
    }
    setReply("");
    setRunning(true); // resume polling — the session picks the message up
  }

  const awaitingReply = Boolean(sessionId) && !running && messages.length > 0 && !error;

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <CardTitle>IG / TikTok content agent</CardTitle>
        <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
          Claude
        </span>
      </div>
      <p className="mb-3 text-sm text-muted-2">
        Runs the carousel content engine for a client: trend research, drafts,
        photo sourcing, rendering, and QA. It pauses to show you drafts — approve or
        steer it in the reply box. Runs take several minutes.
      </p>
      {!sessionId && (
        <Select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={running}
          className="mb-3"
        >
          <option value="" disabled>
            Select a client…
          </option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      )}
      {!sessionId && (
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Optional: custom instructions for this run…"
          rows={2}
          disabled={running}
          className="mb-3 w-full resize-y rounded-lg border border-border bg-surface-2 p-2 text-sm outline-none placeholder:text-muted-2 focus:border-neon"
        />
      )}
      {!sessionId && (
        <Button size="sm" onClick={run} disabled={running || !clientId}>
          <Icon
            name={running ? "Loader" : "Rocket"}
            className={`h-4 w-4 ${running ? "animate-spin" : ""}`}
          />
          {running ? "Starting…" : "Run agent"}
        </Button>
      )}
      {sessionId && running && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Icon name="Loader" className="h-4 w-4 animate-spin" />
          {lastTool ? `Working… (${lastTool})` : "Working…"}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {messages.length > 0 && (
        <div className="mt-3 max-h-80 space-y-3 overflow-y-auto rounded-lg bg-surface-2 p-3">
          {messages.map((m, i) => (
            <p key={i} className="whitespace-pre-wrap text-sm text-foreground/90">
              {m}
            </p>
          ))}
        </div>
      )}
      {awaitingReply && (
        <div className="mt-3 flex gap-2">
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendReply()}
            placeholder="Reply — e.g. “Approved, continue”…"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 p-2 text-sm outline-none placeholder:text-muted-2 focus:border-neon"
          />
          <Button size="sm" onClick={sendReply} disabled={!reply.trim()}>
            <Icon name="Send" className="h-4 w-4" />
            Send
          </Button>
        </div>
      )}
    </Card>
  );
}
