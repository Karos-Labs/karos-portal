"use client";

import { useState, useRef, useEffect, useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { ingestCustomUserTaskAction } from "@/lib/actions";
import { StrategyWarRoom } from "@/components/strategy-war-room";
import type { Client, ClientReport } from "@/lib/types";

/* ── Types ───────────────────────────────────────────────────────────── */

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/* ── Proactive action chip definitions ───────────────────────────────── */

interface ProactiveAction {
  id: string;
  icon: string;
  label: string;
  sublabel: string;
  trigger: string;
  color: string;
}

function buildProactiveActions(hasGoogleIntegration: boolean): ProactiveAction[] {
  return [
    {
      id: "scan_inbox",
      icon: hasGoogleIntegration ? "Globe" : "ListTodo",
      label: "Refresh Task Map",
      sublabel: "Scan market footprint & surface operational priorities",
      trigger:
        "Scan the web and analyze our market footprint for operational action items. Build a comprehensive task map covering website optimizations, content opportunities, and strategic priorities.",
      color: "#FF6B2C",
    },
    {
      id: "competitor_research",
      icon: "TrendingUp",
      label: "Competitor Deep-Dive",
      sublabel: "Generate intel brief + counter-strategy tasks",
      trigger:
        "Help me research a competitor. I'll give you their URL or company name. Start by asking me which competitor to focus on.",
      color: "#6b9fd4",
    },
    {
      id: "brand_audit",
      icon: "Search",
      label: "Brand Visibility Audit",
      sublabel: "Surface presence gaps and push optimization tasks",
      trigger:
        "Run a brand visibility and market presence audit. Identify gaps in our brand positioning and generate specific optimization action items.",
      color: "#d9a13d",
    },
    {
      id: "content_dispatch",
      icon: "Zap",
      label: "AI Content Dispatch",
      sublabel: "Propose & queue managed content runs for this week",
      trigger:
        "Propose which Karos managed products (social posts, newsletter, blog article, landing page) to dispatch for content creation this week, and suggest a concrete content plan.",
      color: "#e5484d",
    },
  ];
}

/* ── Copilot hook ────────────────────────────────────────────────────── */

function useCopilot(
  clientId: string,
  onBrandingChange: () => void,
  onTasksCreated: () => void,
) {
  const router = useRouter();
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
          body: JSON.stringify({ messages: history }),
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
        let tasksCreated = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.includes("Branding guidelines updated")) brandingUpdated = true;
          if (chunk.includes("Created") && chunk.includes("task")) tasksCreated = true;
          accumulated += chunk;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m)),
          );
        }

        if (brandingUpdated) onBrandingChange();
        if (tasksCreated) onTasksCreated();
        // Chat messages charge credits — refresh so the rail's balance pill
        // reflects the new balance.
        router.refresh();
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
    [clientId, messages, streaming, onBrandingChange, onTasksCreated, router],
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

/* ── Proactive welcome (CLIENT_USER initial view) ────────────────────── */

function ProactiveWelcome({
  clientId,
  clientName,
  userName,
  hasGoogleIntegration,
  send,
  onTasksCreated,
  onRefreshTaskMap,
  isAiProcessing,
}: {
  clientId: string;
  clientName: string;
  userName?: string;
  hasGoogleIntegration: boolean;
  send: (t: string) => void;
  onTasksCreated: () => void;
  /** Launches the multi-agent Strategy War Room instead of a single-shot chat scan. */
  onRefreshTaskMap: () => void;
  /** True while a background AI generation cycle is running — locks the Refresh Task Map chip. */
  isAiProcessing?: boolean;
}) {
  const actions = buildProactiveActions(hasGoogleIntegration);
  const greeting = userName ? `Hi ${userName.split(" ")[0]}!` : `Welcome back!`;

  const [taskText, setTaskText] = useState("");
  const [isPending, startTransition] = useTransition();
  const [taskFeedback, setTaskFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  function handleTaskSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = taskText.trim();
    if (!trimmed || isPending) return;
    setTaskFeedback(null);
    startTransition(async () => {
      const result = await ingestCustomUserTaskAction(clientId, trimmed);
      if (result.ok) {
        const label =
          result.owner === "karos_managed" ? "AI-managed task added" : "Action item added";
        setTaskFeedback({ type: "success", message: label });
        setTaskText("");
        onTasksCreated();
        setTimeout(() => setTaskFeedback(null), 3000);
      } else {
        setTaskFeedback({ type: "error", message: result.error ?? "Failed to add task" });
      }
    });
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/* Greeting */}
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-foreground/10 bg-foreground/[0.04] text-foreground/70">
          <Icon name="Sparkles" className="h-4 w-4" />
        </div>
        <div className="rounded-md border border-border bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
          <p className="font-medium">{greeting} I&apos;m your AI Copilot for <strong>{clientName}</strong>.</p>
          <p className="mt-1 text-xs text-muted">
            Choose an action below or describe a task to add it directly.
          </p>
        </div>
      </div>

      {/* Quick task ingestion */}
      <form onSubmit={handleTaskSubmit} className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2 transition-colors focus-within:border-foreground/25">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-neon-soft text-neon">
            <Icon name="Plus" className="h-3 w-3" />
          </span>
          <input
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            placeholder="Describe a task you need done…"
            disabled={isPending}
            maxLength={1000}
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-2 outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!taskText.trim() || isPending}
            className="flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[10px] font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
          >
            {isPending ? (
              <Icon name="Loader" className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <Icon name="Sparkles" className="h-2.5 w-2.5" />
                Add
              </>
            )}
          </button>
        </div>
        {taskFeedback && (
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px]",
              taskFeedback.type === "success"
                ? "border border-success/25 bg-success/10 text-success"
                : "border border-danger/20 bg-danger/5 text-danger",
            )}
          >
            <Icon
              name={taskFeedback.type === "success" ? "CheckCircle" : "TriangleAlert"}
              className="h-3 w-3 shrink-0"
            />
            {taskFeedback.message}
          </div>
        )}
      </form>

      {/* Divider */}
      <div className="flex items-center gap-2 px-1">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[10px] text-muted-2">or run an AI action</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* Action chips */}
      <div className="flex flex-col gap-2">
        {actions.map((action) => {
          const locked = action.id === "scan_inbox" && isAiProcessing;
          return (
            <button
              key={action.id}
              disabled={locked}
              onClick={() => (action.id === "scan_inbox" ? onRefreshTaskMap() : send(action.trigger))}
              title={locked ? "Karos Agents are already building your workspace strategy" : undefined}
              className={cn(
                "group flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3.5 py-3 text-left transition-all duration-150",
                locked
                  ? "cursor-not-allowed opacity-50"
                  : "hover:border-border-strong hover:bg-surface-3 active:scale-[0.98]",
              )}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/70 transition-all duration-150">
                <Icon name={locked ? "Loader" : action.icon} className={cn("h-4 w-4", locked && "animate-spin")} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground">{action.label}</p>
                <p className="text-[11px] text-muted truncate">
                  {locked ? "Locked — a workspace build is already running" : action.sublabel}
                </p>
              </div>
              <Icon
                name="ArrowRight"
                className="h-3.5 w-3.5 shrink-0 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100"
              />
            </button>
          );
        })}
      </div>

      {/* Quick text suggestions */}
      <div className="flex items-center gap-2 px-1">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[10px] text-muted-2">or ask anything</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {["What's our brand positioning?", "Show recent drafts", "Who are our competitors?"].map(
          (prompt) => (
            <button
              key={prompt}
              onClick={() => send(prompt)}
              className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              {prompt}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/* ── Standard empty state (non-proactive) ────────────────────────────── */

const GENERAL_SUGGESTIONS = [
  "What's our brand positioning?",
  "Who are our main competitors?",
  "Update our primary color",
];

function ChatEmptyState({
  clientName,
  send,
}: {
  clientName: string;
  send: (t: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-foreground/10 bg-foreground/[0.04] text-foreground/70">
        <Icon name="Sparkles" className="h-6 w-6" />
      </div>
      <div>
        <p className="text-sm font-medium">Ask me anything</p>
        <p className="mt-1 text-xs text-muted-2">
          I have full context on {clientName}&apos;s brand, competitors, strategy documents, and content history.
        </p>
      </div>
      <div className="mt-1 flex flex-wrap justify-center gap-1.5">
        {GENERAL_SUGGESTIONS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => send(prompt)}
            className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-foreground/30 hover:text-foreground"
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
  /** When true the chat panel opens automatically on mount (CLIENT_USER login). */
  defaultOpen?: boolean;
  /** Display name of the currently logged-in user (for personalised greeting). */
  userName?: string;
  /** Whether this client has an active Google integration (shows Gmail chip). */
  hasGoogleIntegration?: boolean;
  /** Minimal client snapshot injected into the proactive welcome context. */
  client?: Pick<Client, "name" | "website" | "industry" | "isAiProcessing">;
  /** Latest intel report headline data for greeting context. */
  report?: Pick<ClientReport, "overallGrade" | "overallScore"> | null;
  /** Render as an always-open panel filling its container (right rail) instead of a floating popup. */
  docked?: boolean;
  /** When provided (docked mode), shows a collapse control in the header. */
  onCollapse?: () => void;
  /** Position classes for the floating bubble + panel (non-docked mode). */
  floatingPosition?: string;
}

export function ChatbotWidget({
  clientId,
  clientName,
  defaultOpen = false,
  userName,
  hasGoogleIntegration = false,
  client,
  docked = false,
  onCollapse,
  floatingPosition = "bottom-6 right-6",
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [warRoomOpen, setWarRoomOpen] = useState(false);
  // Docked mode is permanently open and never shows the floating bubble.
  const panelOpen = docked || open;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onBrandingChange = useCallback(() => router.refresh(), [router]);
  const onTasksCreated = useCallback(() => router.refresh(), [router]);
  const openWarRoom = useCallback(() => setWarRoomOpen(true), []);

  const { messages, input, setInput, send, streaming, error, reset } = useCopilot(
    clientId,
    onBrandingChange,
    onTasksCreated,
  );

  // Whether to show the proactive welcome instead of the standard empty state
  const showProactiveWelcome = defaultOpen && messages.length === 0;

  // Auto-scroll
  useEffect(() => {
    if (panelOpen) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, panelOpen]);

  // Focus input on open
  useEffect(() => {
    if (panelOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [panelOpen]);

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
      {/* Floating bubble — hidden in docked mode */}
      {!docked && (
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "fixed z-[9999] pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-all hover:scale-105 active:scale-95",
            floatingPosition,
            open ? "bg-surface-2 shadow-black/30 ring-1 ring-border" : "bg-primary",
          )}
          aria-label={open ? "Close AI Copilot" : "Open AI Copilot"}
        >
          <Icon
            name={open ? "X" : "MessageCircle"}
            className={cn("h-6 w-6 transition-colors", open ? "text-foreground" : "text-primary-foreground")}
          />
        </button>
      )}

      {/* Chat panel */}
      {panelOpen && (
        <div
          className={cn(
            "flex flex-col overflow-hidden",
            docked
              ? "h-full w-full bg-background"
              : cn(
                  "fixed z-[9998] h-[600px] max-h-[calc(100vh-6rem)] w-[380px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface shadow-2xl",
                  floatingPosition,
                ),
          )}
        >

          {/* Header — single title; hairline divider, no fill (surface ladder).
              h matches the AppHeader's border-box height (py-2 + h-9 + 1px
              border = 53px) so the two border-b hairlines meet the rail
              border as one continuous straight line. */}
          <div className="flex h-[53px] shrink-0 items-center justify-between gap-3 border-b border-border px-4">
            <div className="min-w-0">
              <p className="font-serif text-base leading-none">AI Copilot</p>
              <p className="mt-1 truncate font-mono text-[9px] uppercase leading-none tracking-[0.12em] text-muted-2">
                {clientName} · Powered by Claude
              </p>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={() => reset()}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
                  aria-label="Clear conversation"
                  title="Clear conversation"
                >
                  <Icon name="RotateCcw" className="h-3.5 w-3.5" />
                </button>
              )}
              {onCollapse && (
                <button
                  onClick={onCollapse}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
                  aria-label="Collapse copilot"
                  title="Collapse"
                >
                  <Icon name="ChevronDown" className="h-4 w-4" />
                </button>
              )}
              {!docked && (
                <button
                  onClick={() => setOpen(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-3 hover:text-foreground"
                  aria-label="Close"
                >
                  <Icon name="X" className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Messages / Welcome */}
          {messages.length === 0 ? (
            showProactiveWelcome ? (
              <ProactiveWelcome
                clientId={clientId}
                clientName={clientName}
                userName={userName}
                hasGoogleIntegration={hasGoogleIntegration}
                send={send}
                onTasksCreated={onTasksCreated}
                onRefreshTaskMap={openWarRoom}
                isAiProcessing={client?.isAiProcessing}
              />
            ) : (
              <ChatEmptyState clientName={clientName} send={send} />
            )
          ) : (
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[88%] rounded-md px-3.5 py-2.5 text-sm leading-relaxed",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "border border-border bg-surface-2 text-foreground",
                    )}
                  >
                    {msg.content ? (
                      <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
                    ) : (
                      <TypingDots />
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
              <Icon name="TriangleAlert" className="h-3.5 w-3.5 shrink-0 text-danger" />
              <p className="text-xs text-danger">{error}</p>
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
                showProactiveWelcome
                  ? "Or type your own question…"
                  : "Ask about performance, brand, competitors…"
              }
              disabled={streaming}
              className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-2 outline-none focus:border-foreground/25 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || streaming}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
              aria-label="Send"
            >
              {streaming ? (
                <Icon name="Loader" className="h-4 w-4 animate-spin" />
              ) : (
                <Icon name="ArrowUp" className="h-4 w-4" />
              )}
            </button>
          </form>
        </div>
      )}

      {warRoomOpen && (
        <StrategyWarRoom
          clientId={clientId}
          onClose={() => setWarRoomOpen(false)}
          onComplete={() => router.refresh()}
        />
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
