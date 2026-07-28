"use client";

import { useState, useRef, useEffect, useCallback, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { ingestCustomUserTaskAction } from "@/lib/actions";
import { renderSectionBody } from "@/lib/doc-render";
import { StrategyWarRoom } from "@/components/strategy-war-room";
import type { Client, ClientReport } from "@/lib/types";

/* ── Types ───────────────────────────────────────────────────────────── */

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/* ── Transcript persistence ──────────────────────────────────────────── */

/**
 * Per-client sessionStorage key for the copilot transcript. Every message is
 * charged to the client, so a hard reload must not silently destroy a paid
 * conversation (QA F88). sessionStorage (not local) keeps it to the tab.
 */
const THREAD_KEY_PREFIX = "karos.copilot.thread.";
/** Cap what we write back — a long thread is not worth a quota error. */
const MAX_PERSISTED_MESSAGES = 40;

function isPersistedMessage(v: unknown): v is Message {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string"
  );
}

/* ── Proactive action chip definitions ───────────────────────────────── */

interface ProactiveAction {
  id: string;
  icon: string;
  label: string;
  sublabel: string;
  /** Chat message this chip sends. Omitted for chips handled by a dedicated UI. */
  trigger?: string;
  color: string;
}

function buildProactiveActions(): ProactiveAction[] {
  return [
    {
      // Handled by the Strategy War Room, not the chat path — so no trigger.
      // The swarm reads the client's calendar gaps, brand guidance, past
      // engagement and custom agents; it does NOT look at the web, the client's
      // site or the inbox, so the label must not promise a market scan (QA F50).
      id: "scan_inbox",
      icon: "ListTodo",
      label: "Refresh Task Map",
      sublabel: "Rebuild your task map from calendar gaps and past performance",
      color: "#FF6B2C",
    },
    {
      // The copilot has no web search and no page fetch — the only competitor
      // intelligence it holds is the tracked competitor list already stored on
      // the account. Asking for a URL promised a page visit that never happens
      // (QA F87), so both the sublabel and the trigger name the real source.
      id: "competitor_research",
      icon: "TrendingUp",
      label: "Competitor Deep-Dive",
      sublabel: "Brief on a tracked competitor + counter-strategy tasks",
      trigger:
        "Give me an intel brief on one of the competitors in our tracker, built from the tracked competitor data you already hold. Start by asking me which tracked competitor to focus on.",
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
  const storageKey = `${THREAD_KEY_PREFIX}${clientId}`;
  /** Blocks the write-back below until the restore pass has run. */
  const hydratedRef = useRef(false);

  // Restore the transcript for this client. Runs after mount rather than in a
  // lazy initializer so the server-rendered (empty) markup and the first client
  // render still agree.
  useEffect(() => {
    hydratedRef.current = false;
    try {
      const raw = sessionStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        const restored = parsed.filter(isPersistedMessage);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted state on mount is the point
        if (restored.length > 0) setMessages(restored);
      }
    } catch {
      /* unreadable / disabled storage — start clean */
    }
    hydratedRef.current = true;
  }, [storageKey]);

  // Write back once a turn settles. Skipped mid-stream so a long answer isn't
  // serialized on every chunk.
  useEffect(() => {
    if (!hydratedRef.current || streaming) return;
    try {
      if (messages.length === 0) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify(messages.slice(-MAX_PERSISTED_MESSAGES)));
    } catch {
      /* quota or private mode — the in-memory thread still works */
    }
  }, [messages, streaming, storageKey]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    setError(null);
    setStreaming(false);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* nothing to clear */
    }
  }, [storageKey]);

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

/* ── Quick task ingestion form ───────────────────────────────────────── */

/**
 * Extracted from the welcome column so it can also render in the actions strip
 * above the input bar — the whole action surface used to exist only while the
 * transcript was empty (QA F88).
 */
function QuickTaskForm({
  clientId,
  onTasksCreated,
}: {
  clientId: string;
  onTasksCreated: () => void;
}) {
  const [taskText, setTaskText] = useState("");
  const [isPending, startTransition] = useTransition();
  // "info" is the duplicate case: nothing failed, the work is already on the
  // board — it used to render in the red danger style (QA F61).
  const [taskFeedback, setTaskFeedback] = useState<{
    type: "success" | "info" | "error";
    message: string;
    /** Where the created task lives, so the confirmation can hand you off (QA F65). */
    href?: string;
  } | null>(null);

  function handleTaskSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = taskText.trim();
    if (!trimmed || isPending) return;
    setTaskFeedback(null);
    startTransition(async () => {
      const result = await ingestCustomUserTaskAction(clientId, trimmed);
      if (result.ok) {
        // Show the title the router actually created — it rewrites what the
        // user typed, so the card may not carry their words (QA F65).
        const label = result.title
          ? `Added “${result.title}”`
          : result.owner === "karos_managed"
            ? "AI-managed task added"
            : "Action item added";
        const owner = result.owner === "client_managed" ? "client" : "karos";
        setTaskFeedback({
          type: "success",
          message: label,
          href: result.taskId ? `/tasks?owner=${owner}&task=${result.taskId}` : "/tasks",
        });
        setTaskText("");
        onTasksCreated();
      } else {
        setTaskFeedback({
          type: result.duplicate ? "info" : "error",
          message: result.error ?? "Failed to add task",
        });
      }
    });
  }

  return (
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
              : taskFeedback.type === "info"
                ? "border border-border bg-surface-2 text-muted"
                : "border border-danger/20 bg-danger/5 text-danger",
          )}
        >
          <Icon
            name={
              taskFeedback.type === "success"
                ? "CircleCheck"
                : taskFeedback.type === "info"
                  ? "Info"
                  : "TriangleAlert"
            }
            className="h-3 w-3 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{taskFeedback.message}</span>
          {taskFeedback.href && (
            <Link
              href={taskFeedback.href}
              className="shrink-0 font-semibold underline underline-offset-2 hover:opacity-80"
            >
              View
            </Link>
          )}
        </div>
      )}
    </form>
  );
}

/* ── Action chips ────────────────────────────────────────────────────── */

/**
 * The four AI actions. Extracted from the welcome column so the same list can
 * render in the strip above the input bar once a transcript exists (QA F88).
 */
function ActionChips({
  onRun,
  onRefreshTaskMap,
  isAiProcessing,
}: {
  /** Sends the action's chat trigger; `display` is what the transcript shows (QA F15). */
  onRun: (trigger: string, display: string) => void;
  onRefreshTaskMap: () => void;
  isAiProcessing?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {buildProactiveActions().map((action) => {
        const locked = action.id === "scan_inbox" && isAiProcessing;
        return (
          <button
            key={action.id}
            disabled={locked}
            onClick={() =>
              action.trigger ? onRun(action.trigger, action.label) : onRefreshTaskMap()
            }
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
              {/* Two lines, not `truncate`: the longest sublabels clipped
                  mid-phrase on a single line (QA F88). */}
              <p className="line-clamp-2 text-[11px] text-muted">
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
  send: (t: string, display?: string) => void;
  onTasksCreated: () => void;
  /** Launches the multi-agent Strategy War Room instead of a single-shot chat scan. */
  onRefreshTaskMap: () => void;
  /** True while a background AI generation cycle is running — locks the Refresh Task Map chip. */
  isAiProcessing?: boolean;
}) {
  // Kept on the prop chain (layout → dock → widget) but no longer decorates the
  // Refresh Task Map chip: a Google connection changed the icon to a globe while
  // nothing in the run ever looked outside the account (QA F50).
  void hasGoogleIntegration;
  const greeting = userName ? `Hi ${userName.split(" ")[0]}!` : `Welcome back!`;

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

      <QuickTaskForm clientId={clientId} onTasksCreated={onTasksCreated} />

      {/* Divider */}
      <div className="flex items-center gap-2 px-1">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[10px] text-muted-2">or run an AI action</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <ActionChips
        onRun={send}
        onRefreshTaskMap={onRefreshTaskMap}
        isAiProcessing={isAiProcessing}
      />

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
  // The AI actions strip above the input bar, once a transcript exists. Starts
  // collapsed so it never crowds the answers (QA F88).
  const [actionsOpen, setActionsOpen] = useState(false);
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
                      msg.role === "assistant" ? (
                        // The model writes markdown — the system prompt is itself
                        // authored in it and the flagship actions ask for
                        // multi-section deliverables — so a pre-wrapped span put
                        // asterisks, hash marks and table pipes on screen (QA F89).
                        // renderSectionBody escapes before formatting, so model
                        // output cannot inject markup; it is the same renderer the
                        // documents view uses.
                        <div dangerouslySetInnerHTML={{ __html: renderSectionBody(msg.content) }} />
                      ) : (
                        <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
                      )
                    ) : (
                      <TypingDots />
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}

          {/* AI actions strip — the four actions and the quick-add form used to
              exist only while the transcript was empty, so the panel's whole
              action surface was a zero-state and the only way back to it was
              the header's reset, which destroys a paid thread (QA F88). */}
          {defaultOpen && messages.length > 0 && (
            <div className="shrink-0 border-t border-border">
              <button
                type="button"
                onClick={() => setActionsOpen((v) => !v)}
                aria-expanded={actionsOpen}
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
              >
                <Icon name="Sparkles" className="h-3.5 w-3.5 shrink-0 text-muted-2" />
                <span className="flex-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">
                  AI actions
                </span>
                <Icon
                  name={actionsOpen ? "ChevronDown" : "ChevronUp"}
                  className="h-3.5 w-3.5 shrink-0 text-muted-2"
                />
              </button>
              {actionsOpen && (
                <div className="flex max-h-[45dvh] flex-col gap-3 overflow-y-auto border-t border-border px-3 py-3">
                  <QuickTaskForm clientId={clientId} onTasksCreated={onTasksCreated} />
                  <ActionChips
                    onRun={send}
                    onRefreshTaskMap={openWarRoom}
                    isAiProcessing={client?.isAiProcessing}
                  />
                </div>
              )}
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
