"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import type { Agent } from "@/lib/types";

/* ── Types ───────────────────────────────────────────────────────────── */

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

type CopilotMode =
  | { type: "general" }
  | { type: "agent"; agent: Agent };

/* ── Copilot hook ────────────────────────────────────────────────────── */

function useCopilot(
  clientId: string,
  agentId: string | null,
  onBrandingChange: () => void,
  onJobStarted: () => void,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    setError(null);
    setStreaming(false);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: trimmed };
      const assistantId = crypto.randomUUID();

      setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", content: "" }]);
      setInput("");
      setStreaming(true);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      const history = [...messages, userMsg].map(({ role, content }) => ({ role, content }));

      try {
        const response = await fetch(`/api/clients/${clientId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history, agentId }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errBody = await response.json().catch(() => ({ error: "Request failed" }));
          throw new Error((errBody as { error?: string }).error ?? `HTTP ${response.status}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let brandingUpdated = false;
        let jobStarted = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.includes("Branding guidelines updated")) brandingUpdated = true;
          if (chunk.includes("Run started successfully")) jobStarted = true;
          accumulated += chunk;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m)),
          );
        }

        if (brandingUpdated) onBrandingChange();
        if (jobStarted) onJobStarted();
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          return;
        }
        setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      } finally {
        setStreaming(false);
      }
    },
    [clientId, agentId, messages, streaming, onBrandingChange, onJobStarted],
  );

  return { messages, input, setInput, send, streaming, error, reset };
}

/* ── Typing dots ─────────────────────────────────────────────────────── */

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 rounded-full bg-current opacity-60"
          style={{ animation: `bounce 1s ${delay}ms infinite` }}
        />
      ))}
    </span>
  );
}

/* ── Mode selector ───────────────────────────────────────────────────── */

function ModeSelector({
  mode,
  agents,
  onChange,
}: {
  mode: CopilotMode;
  agents: Agent[];
  onChange: (mode: CopilotMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const isAgent = mode.type === "agent";
  const agentColor = isAgent ? (mode.agent.color ?? "#2dff9e") : null;
  const label = isAgent ? mode.agent.name : "General Client Assistant";

  return (
    <div ref={ref} className="relative shrink-0 border-b border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-surface-2"
      >
        {/* Mode icon */}
        {isAgent ? (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px]"
            style={{ background: agentColor! + "1f", color: agentColor! }}
          >
            <Icon name={mode.agent.icon} className="h-3 w-3" />
          </span>
        ) : (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-neon-soft">
            <Icon name="Bot" className="h-3 w-3 text-neon" />
          </span>
        )}

        <span className="flex-1 truncate text-xs font-medium text-muted">{label}</span>

        <span className="text-[10px] text-muted-2 shrink-0 mr-1">Mode</span>
        <Icon
          name="ChevronDown"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-2 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Dropdown — opens into the messages area; z-50 so it overlays */}
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 border-b border-border bg-surface shadow-xl animate-fade-up">
          {/* General */}
          <button
            className={cn(
              "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-xs transition-colors hover:bg-surface-2",
              mode.type === "general" && "text-neon",
            )}
            onClick={() => { onChange({ type: "general" }); setOpen(false); }}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-neon-soft">
              <Icon name="Bot" className="h-3 w-3 text-neon" />
            </span>
            <span className="flex-1">General Client Assistant</span>
            {mode.type === "general" && <Icon name="Check" className="h-3 w-3 shrink-0 text-neon" />}
          </button>

          {/* Agent options */}
          {agents.length > 0 && <div className="mx-3 h-px bg-border" />}
          {agents.map((agent) => {
            const color = agent.color ?? "#2dff9e";
            const selected = mode.type === "agent" && mode.agent.id === agent.id;
            return (
              <button
                key={agent.id}
                className={cn(
                  "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-xs transition-colors hover:bg-surface-2",
                  selected && "text-neon",
                )}
                onClick={() => { onChange({ type: "agent", agent }); setOpen(false); }}
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px]"
                  style={{ background: color + "1f", color }}
                >
                  <Icon name={agent.icon} className="h-3 w-3" />
                </span>
                <span className="flex-1 truncate">{agent.name}</span>
                {selected && <Icon name="Check" className="h-3 w-3 shrink-0 text-neon" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Empty state ─────────────────────────────────────────────────────── */

const GENERAL_SUGGESTIONS = [
  "What's our brand positioning?",
  "Who are our main competitors?",
  "Update our primary color",
];

const AGENT_SUGGESTIONS = [
  "Show pending drafts",
  "/run new generation",
  "Rewrite draft #1 caption",
];

function ChatEmptyState({
  mode,
  clientName,
  send,
}: {
  mode: CopilotMode;
  clientName: string;
  send: (t: string) => void;
}) {
  const isAgent = mode.type === "agent";
  const agentColor = isAgent ? (mode.agent.color ?? "#2dff9e") : null;
  const title = isAgent ? `${mode.agent.name} Copilot` : "Ask me anything";
  const desc = isAgent
    ? `I can show drafts, trigger new runs, and help you edit content for the ${mode.agent.name} pipeline.`
    : `I have full context on ${clientName}'s brand, competitors, strategy documents, and content history.`;
  const suggestions = isAgent ? AGENT_SUGGESTIONS : GENERAL_SUGGESTIONS;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full"
        style={
          agentColor
            ? { background: agentColor + "1f", color: agentColor }
            : { background: "var(--neon-soft)", color: "var(--neon)" }
        }
      >
        <Icon name={isAgent ? mode.agent.icon : "Sparkles"} className="h-6 w-6" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-2">{desc}</p>
      </div>
      <div className="mt-1 flex flex-wrap justify-center gap-1.5">
        {suggestions.map((prompt) => (
          <button
            key={prompt}
            onClick={() => send(prompt)}
            className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-neon/40 hover:text-foreground"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

interface Props {
  clientId: string;
  clientName: string;
  /** Active, non-system agents — shown as selectable modes in the dropdown. */
  agents: Agent[];
}

export function ChatbotWidget({ clientId, clientName, agents }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CopilotMode>({ type: "general" });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onBrandingChange = useCallback(() => router.refresh(), [router]);
  const onJobStarted = useCallback(() => router.refresh(), [router]);

  const agentId = mode.type === "agent" ? mode.agent.id : null;
  const agentColor = mode.type === "agent" ? (mode.agent.color ?? "#2dff9e") : null;

  const { messages, input, setInput, send, streaming, error, reset } = useCopilot(
    clientId,
    agentId,
    onBrandingChange,
    onJobStarted,
  );

  function handleModeChange(newMode: CopilotMode) {
    reset();
    setMode(newMode);
  }

  // Auto-scroll
  useEffect(() => {
    if (open) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  // Focus input on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <>
      {/* Floating bubble */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-6 right-6 z-[9999] pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-all hover:scale-105 active:scale-95",
          open
            ? "bg-surface-2 shadow-black/30 ring-1 ring-border"
            : !agentColor
              ? "bg-neon shadow-neon/30"
              : "",
        )}
        style={
          !open && agentColor
            ? { background: agentColor, boxShadow: `0 0 20px ${agentColor}4d` }
            : undefined
        }
        aria-label={open ? "Close AI Copilot" : "Open AI Copilot"}
      >
        <Icon
          name={open ? "X" : mode.type === "agent" ? mode.agent.icon : "MessageCircle"}
          className={cn("h-6 w-6 transition-colors", open ? "text-foreground" : "text-black")}
        />
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-6 right-6 z-[9998] flex h-[580px] w-[360px] flex-col overflow-hidden rounded-[20px] border border-border bg-surface shadow-2xl">

          {/* Header */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-2 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
                style={
                  agentColor
                    ? { background: agentColor + "1f", color: agentColor }
                    : { background: "var(--neon-soft)", color: "var(--neon)" }
                }
              >
                <Icon name={mode.type === "agent" ? mode.agent.icon : "Bot"} className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">AI Copilot</p>
                <p className="mt-0.5 text-[10px] leading-none text-muted-2">
                  {clientName} · Powered by Claude
                </p>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
              aria-label="Close"
            >
              <Icon name="X" className="h-4 w-4" />
            </button>
          </div>

          {/* Mode selector bar */}
          <ModeSelector mode={mode} agents={agents} onChange={handleModeChange} />

          {/* Messages */}
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <ChatEmptyState mode={mode} clientName={clientName} send={send} />
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[88%] rounded-[14px] px-3.5 py-2.5 text-sm leading-relaxed",
                      msg.role === "user"
                        ? "text-black"
                        : "border border-border bg-surface-2 text-foreground",
                    )}
                    style={
                      msg.role === "user"
                        ? { background: agentColor ?? "var(--neon)" }
                        : undefined
                    }
                  >
                    {msg.content ? (
                      <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
                    ) : (
                      <TypingDots />
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Error banner */}
          {error && (
            <div className="mx-3 mb-2 flex items-center gap-2 rounded-[8px] border border-red-500/30 bg-red-500/10 px-3 py-2">
              <Icon name="TriangleAlert" className="h-3.5 w-3.5 shrink-0 text-red-400" />
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {/* Input bar */}
          <form
            onSubmit={handleSubmit}
            className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-3"
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode.type === "agent"
                  ? "Ask about drafts, type /run to generate…"
                  : "Ask about performance, brand, competitors…"
              }
              disabled={streaming}
              className="flex-1 rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-2 outline-none focus:border-neon/50 focus:ring-1 focus:ring-neon/30 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || streaming}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-black transition-opacity disabled:opacity-40"
              style={{ background: agentColor ?? "var(--neon)" }}
              aria-label="Send"
            >
              {streaming ? (
                <Icon name="Loader" className="h-4 w-4 animate-spin" />
              ) : (
                <Icon name="Send" className="h-4 w-4" />
              )}
            </button>
          </form>
        </div>
      )}

      <style>{`
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
      `}</style>
    </>
  );
}
