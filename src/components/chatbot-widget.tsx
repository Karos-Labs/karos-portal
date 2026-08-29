"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { SocialPlatformMark, type SocialPlatform } from "@/components/agent-identity";
import { cn } from "@/lib/utils";
import { ingestCustomUserTaskAction } from "@/lib/actions";
import { renderSectionBody } from "@/lib/doc-render";
import { readChatStream } from "@/lib/chat/client-stream";
import type { ClientReport } from "@/lib/types";
import { CHAT_MODEL_KEYS, CHAT_MODEL_OPTIONS, type ChatModelKey } from "@/lib/ai/chat-models";

/* ── Types ───────────────────────────────────────────────────────────── */

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * What the transcript shows in place of `content`. An action chip's hidden
   * instruction used to be rendered in the user bubble, so the client was
   * shown words they never wrote - including an order aimed at the model
   * ("Start by asking me…") and internal product vocabulary (QA F15).
   * `content` is still what goes to the API.
   */
  display?: string;
}

/** One of this client's LIVE agents, offered in the `@mention` dropdown. */
interface MentionableAgent {
  id: string;
  displayName: string;
  icon: string;
  /**
   * Which platform this agent posts to (AF-20), resolved by the route through
   * lib/content-platform and sent as a token. Null for the agents that target
   * none (Landing Builder), and those keep their stored lucide icon.
   */
  platform: SocialPlatform | null;
}

/**
 * A focused-agent chip set by picking `@AgentName` - biases, not locks, the chat.
 *
 * Deliberately NOT carrying a platform of its own, even though the chip draws
 * one: focus is set from two places, and only one of them holds a roster row.
 * The other is the copilot's own `set_agent_focus` marker, which names an agent
 * in prose mid-stream from inside a hook that never sees the mention list. A
 * field here would be filled on one path and empty on the other, so the same
 * chip would wear a logo or not depending on how the user got to it. The chip
 * looks the id up in the roster at render instead - one answer, both paths.
 */
interface FocusAgent {
  id: string;
  name: string;
}

/* ── Transcript persistence ──────────────────────────────────────────── */

/**
 * Per-client sessionStorage key for the copilot transcript. Every message is
 * charged to the client, so a hard reload must not silently destroy a paid
 * conversation (QA F88). sessionStorage (not local) keeps it to the tab.
 */
const THREAD_KEY_PREFIX = "karos.copilot.thread.";
/** Cap what we write back - a long thread is not worth a quota error. */
const MAX_PERSISTED_MESSAGES = 40;

function isPersistedMessage(v: unknown): v is Message {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string" &&
    (m.display === undefined || typeof m.display === "string")
  );
}

/* ── Proactive action chip definitions ───────────────────────────────── */

interface ProactiveAction {
  id: string;
  icon: string;
  label: string;
  sublabel: string;
  /** Chat message this chip sends. */
  trigger: string;
  color: string;
  /**
   * Opts into Sonnet instead of the copilot's default Haiku model - this is a
   * plain chatbot, so most turns (including a focused-agent conversation) run
   * cheap. These three run multi-step tool orchestration over a full strategy
   * write-up, not a quick Q&A turn, so they ask for the stronger model.
   */
  deep?: boolean;
}

function buildProactiveActions(): ProactiveAction[] {
  return [
    {
      // The copilot has no web search and no page fetch - the only competitor
      // intelligence it holds is the tracked competitor list already stored on
      // the account. Asking for a URL promised a page visit that never happens
      // (QA F87), so both the sublabel and the trigger name the real source.
      id: "competitor_research",
      icon: "TrendingUp",
      label: "Competitor Deep-Dive",
      sublabel: "Brief on a tracked competitor + counter-strategy tasks",
      trigger:
        "Give me an intel brief on one of the competitors in our tracker, built from the tracked competitor data you already hold. Start by asking me which tracked competitor to focus on.",
      color: "var(--info)",
      deep: true,
    },
    {
      id: "brand_audit",
      icon: "Search",
      label: "Brand Visibility Audit",
      sublabel: "Surface presence gaps and push optimization tasks",
      trigger:
        "Run a brand visibility and market presence audit. Identify gaps in our brand positioning and generate specific optimization action items.",
      color: "var(--warning)",
      deep: true,
    },
    {
      // "Queue" claimed an execution step this path never performs: the only
      // write is pending task cards, and a run starts when a human later moves
      // a card into In Progress (QA F91).
      //
      // "Dispatch" was the same mistake one layer up (A3): it named the
      // machinery - a batch being sent somewhere - on a chip a client presses.
      // The label says what the client ends up with. Same rename as the board
      // chip in tasks-board.tsx; neither surface branches by role, so there is
      // no staff naming to preserve here.
      //
      // The trigger names no specific product: it used to hardcode "social
      // posts, newsletter, blog article, landing page", which is only the
      // managed-product half of the roster and ignores whatever custom agents
      // this account has been granted (agent-roster.ts unifies both into one
      // catalog for exactly this reason). Naming the four here would re-narrow
      // the model back to them regardless of what the system prompt's live
      // AVAILABLE AGENTS registry actually lists for this client.
      id: "content_dispatch",
      icon: "Zap",
      label: "Content Plan",
      sublabel: "Propose this week's content plan as ready-to-run tasks",
      trigger:
        "Propose a content plan for this week using the AI agents actually available on this account, and suggest a concrete plan I can turn into tasks.",
      color: "var(--danger)",
      deep: true,
    },
  ];
}

/**
 * The `/` command palette. Each entry either inserts a scaffold sentence into
 * the input - the same idiom the action chips' `trigger` strings already use,
 * so completing it and sending is an ordinary chat turn the new capability-
 * matrix tools (find_output/edit_output/run_agent_now/reschedule_output/
 * provide_feedback, chat/route.ts) answer - or, for `/add-task`, is handled
 * entirely client-side (see `sendAddTask`) to keep the cheap, deterministic
 * Haiku-routed path `QuickTaskForm` used to front, now reached from the main
 * input instead of a separate card.
 */
interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  /** Absent only for `add-task`, which is special-cased in handleSubmit. */
  scaffold?: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: "add-task", label: "/add-task", hint: "Quickly add a task to your board" },
  {
    id: "edit-output",
    label: "/edit-output",
    hint: "Revise a post or asset you already have",
    scaffold: "I'd like to revise one of my generated posts. Here's what to change: ",
  },
  {
    id: "schedule-run",
    label: "/schedule-run",
    hint: "Run one of your agents right now",
    scaffold: "Please run ",
  },
  {
    id: "reschedule-post",
    label: "/reschedule-post",
    hint: "Move a scheduled post to a new date/time",
    scaffold: "I'd like to move the publish date for ",
  },
  {
    id: "inspect-job",
    label: "/inspect-job",
    hint: "Check the status of a specific output",
    scaffold: "What's the status of ",
  },
  {
    id: "provide-feedback",
    label: "/provide-feedback",
    hint: "Give standing feedback on one of your agents",
    scaffold: "I want to give feedback on ",
  },
];

/**
 * What the transcript says after `/add-task`.
 *
 * USED TO CARRY A "[View]" LINK TO THE TASK, KEYED ON ITS ID (#122, F65) —
 * REVERSED 2026-08. That link opened the Workspace board straight to the
 * ticket, deliberately keyed on `?task=` rather than a guessed `?owner=` tab so
 * the reader always landed on the card just named. The board is gone entirely
 * now, and nothing replaced it as a screen that shows one task by id — Home's
 * own attention rows hit the identical wall and went the same way
 * (client-home-overview.tsx's `taskBoardHref` removal; notification-bell.tsx's
 * `TaskAlertRow`), so this reply now drops the link rather than naming a
 * destination the reader cannot reach.
 */
export function addTaskReply(
  result: Pick<
    Awaited<ReturnType<typeof ingestCustomUserTaskAction>>,
    "ok" | "title" | "taskId" | "error" | "duplicate"
  >,
): string {
  if (!result.ok) {
    return result.duplicate
      ? (result.error ?? "That's already on your task board.")
      : (result.error ?? "Couldn't add that task. Try again.");
  }
  return `Added${result.title ? ` "${result.title}"` : ""} to your task board.`;
}

/* ── Copilot hook ────────────────────────────────────────────────────── */

function useCopilot(
  clientId: string,
  viewerUid: string,
  onBrandingChange: () => void,
  onTasksCreated: () => void,
) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set by picking `@AgentName` - sent as `focusAgentId` on every turn until cleared. */
  const [focusAgent, setFocusAgent] = useState<FocusAgent | null>(null);
  /**
   * Manual model-picker override (T-B3/SCRUM-246). `null` means "Auto" - the
   * route's own cost-based routing (cheap Gemini by default, Haiku for a
   * `deep` proactive action) decides. A picked key is sent as `model` on
   * every turn until cleared, taking priority over `deep` server-side
   * (`resolveChatModel`, lib/ai/chat-models.ts) - picking "Fast" even
   * overrides one of the three proactive actions' own `deep: true`. Session-
   * only by design, unlike `focusAgent`: a cost preference from a prior visit
   * silently carrying into a new one is a worse default than just asking
   * again, and this is a plain UI convenience, not billed state worth a
   * client-visible receipt.
   */
  const [preferredModel, setPreferredModel] = useState<ChatModelKey | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Scoped to viewer AND client: sessionStorage survives sign-out in the same
  // tab, and StaffCopilotDock writes under this prefix too - an unscoped key
  // let the next signed-in user restore the previous one's transcript, which
  // for a staff→client handover means internal-tier context in a client's pane.
  const storageKey = `${THREAD_KEY_PREFIX}${viewerUid || "anon"}.${clientId}`;
  /** Separate key, same scoping - the focus survives independently of clearing the transcript. */
  const focusStorageKey = `${THREAD_KEY_PREFIX}focus.${viewerUid || "anon"}.${clientId}`;
  /** Blocks the write-back below until the restore pass has run. */
  const hydratedRef = useRef(false);

  // Restore the transcript AND the focused agent for this client. Runs after
  // mount rather than in a lazy initializer so the server-rendered (empty)
  // markup and the first client render still agree. The two live in the same
  // effect so `hydratedRef` gates both write-backs from the same instant -
  // a client who picked an agent expects it to survive a reload exactly like
  // the transcript already does, not silently reset to the general copilot.
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
      /* unreadable / disabled storage - start clean */
    }
    try {
      const rawFocus = sessionStorage.getItem(focusStorageKey);
      const parsedFocus: unknown = rawFocus ? JSON.parse(rawFocus) : null;
      if (
        parsedFocus &&
        typeof parsedFocus === "object" &&
        typeof (parsedFocus as Record<string, unknown>).id === "string" &&
        typeof (parsedFocus as Record<string, unknown>).name === "string"
      ) {
        setFocusAgent(parsedFocus as FocusAgent);
      }
    } catch {
      /* unreadable / disabled storage - starts unfocused */
    }
    hydratedRef.current = true;
  }, [storageKey, focusStorageKey]);

  // Write the focus back on every change once hydrated - unlike the transcript,
  // an explicit clear (null) DOES get persisted here: there is no dual-mount
  // "empty means not-yet-restored" ambiguity for a single id, only ever a
  // deliberate pick, a deliberate clear, or the restore pass itself.
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      if (focusAgent) sessionStorage.setItem(focusStorageKey, JSON.stringify(focusAgent));
      else sessionStorage.removeItem(focusStorageKey);
    } catch {
      /* quota or private mode - focus stays in memory for this session only */
    }
  }, [focusAgent, focusStorageKey]);

  // Write back once a turn settles. Skipped mid-stream so a long answer isn't
  // serialized on every chunk.
  useEffect(() => {
    if (!hydratedRef.current || streaming) return;
    try {
      // Never clear on empty. CopilotDock mounts TWO widgets (mobile sheet +
      // desktop rail) against this same key; the hidden one can render with an
      // empty list and would otherwise wipe the thread the visible one just
      // restored. reset() clears the key explicitly, which is the only path
      // that should.
      if (messages.length === 0) return;
      sessionStorage.setItem(storageKey, JSON.stringify(messages.slice(-MAX_PERSISTED_MESSAGES)));
    } catch {
      /* quota or private mode - the in-memory thread still works */
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
    /**
     * @param display Shown in the user bubble instead of `text` - used by the
     * action chips, whose trigger is an instruction to the model, not a
     * sentence the client typed (QA F15). `text` is what the API receives.
     * @param deep Opts this one turn into Sonnet - the 3 substantive proactive
     * actions set it; everything else runs on the copilot's default cheap model.
     */
    async (text: string, display?: string, deep?: boolean) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        ...(display ? { display } : {}),
      };
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
          body: JSON.stringify({
            messages: history,
            ...(focusAgent ? { focusAgentId: focusAgent.id } : {}),
            ...(deep ? { deep: true } : {}),
            // Sent as one of CHAT_MODEL_OPTIONS's keys, never a raw model id -
            // the route treats this exactly as untrusted as any other request
            // body field and validates it against its own server-side copy of
            // the same allowlist (resolveChatModel, lib/ai/chat-models.ts).
            ...(preferredModel ? { model: preferredModel } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errBody = await response.json().catch(() => ({ error: "Request failed" }));
          throw new Error((errBody as { error?: string }).error ?? `HTTP ${response.status}`);
        }

        // T-B4: the route now returns a real UI-message stream (typed data
        // parts, tool-call/tool-result parts) instead of a bare text body.
        // `readChatStream` decodes it into the events this handler reacts to.
        let accumulated = "";
        let brandingUpdated = false;
        let tasksCreated = false;
        let sawErrorPart = false;

        for await (const evt of readChatStream(response)) {
          switch (evt.type) {
            case "text-delta":
              accumulated += evt.delta;
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m)),
              );
              break;
            case "agent-focus":
              // Replaces the old COPILOT_FOCUS HTML-comment sniff: a typed
              // data part instead of text regexed out of the raw stream.
              setFocusAgent(evt.focusAgent);
              break;
            case "tool-result":
              // Replaces sniffing the model's own PROSE for magic substrings
              // ("Branding guidelines updated", "Created ... task") - these
              // are the tool's actual name and return value, not a guess
              // about how the model chose to phrase its answer.
              if (evt.toolName === "update_branding_guidelines") brandingUpdated = true;
              if (evt.toolName === "create_tasks" && typeof evt.output === "string" && evt.output.startsWith("Created ")) {
                tasksCreated = true;
              }
              break;
            case "error":
              sawErrorPart = true;
              break;
          }
        }

        // A provider failure mid-stream (token depletion, a 5xx) now arrives
        // as a real `error` protocol part (T-B4) - detected directly, rather
        // than inferred from "the turn produced no visible text at all" the
        // way the old text-only protocol forced this to be. The no-visible-
        // text check stays as a backstop for any other empty-completion case.
        const visibleContent = accumulated.trim();
        if (sawErrorPart || !visibleContent) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: "A temporary error occurred. Sending an error report to the Karos team." }
                : m,
            ),
          );
          router.refresh();
          return;
        }

        if (brandingUpdated) onBrandingChange();
        if (tasksCreated) onTasksCreated();
        // Chat messages charge credits - refresh so the rail's balance pill
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
    [clientId, messages, streaming, focusAgent, preferredModel, onBrandingChange, onTasksCreated, router],
  );

  /**
   * `/add-task` - the fast path `QuickTaskForm` used to front, reached from
   * the main input instead of a separate card. Deliberately NOT a chat turn:
   * it calls `ingestCustomUserTaskAction` directly (its own cheap Haiku
   * routing + dedup, its own `task_assist` credit charge), so folding task
   * creation into the main input doesn't also fold it into the pricier,
   * slower `chat_message` path. The transcript still shows it as a turn -
   * the user's literal command, then the routed result - so the two ways of
   * adding a task don't read as two different features.
   */
  const sendAddTask = useCallback(
    async (taskText: string) => {
      const trimmed = taskText.trim();
      if (!trimmed || streaming) return;

      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: `/add-task ${trimmed}`,
      };
      const assistantId = crypto.randomUUID();
      setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", content: "" }]);
      setInput("");
      setStreaming(true);
      setError(null);

      try {
        const result = await ingestCustomUserTaskAction(clientId, trimmed);
        const reply = addTaskReply(result);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: reply } : m)));
        if (result.ok) onTasksCreated();
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: "Couldn't add that task. Try again." } : m,
          ),
        );
      } finally {
        setStreaming(false);
      }
    },
    [clientId, streaming, onTasksCreated],
  );

  return {
    messages, input, setInput, send, sendAddTask, streaming, error, reset,
    focusAgent, setFocusAgent, preferredModel, setPreferredModel,
  };
}

/* ── Manual model picker ─────────────────────────────────────────────── */

/**
 * T-B3/SCRUM-246's manual override. "Auto" (the default, `value === null`)
 * defers to the route's own cost-based routing; the other two pills force a
 * specific allowlisted model for every turn until changed back. Rendered
 * from `CHAT_MODEL_KEYS`/`CHAT_MODEL_OPTIONS` rather than a hardcoded copy of
 * the label pair, so this can never drift from the actual server-side
 * allowlist it is choosing keys out of.
 */
function ModelPicker({
  value,
  onChange,
}: {
  value: ChatModelKey | null;
  onChange: (key: ChatModelKey | null) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-t border-border px-3 pt-2 text-[11px]">
      <span className="mr-0.5 text-muted-2">Model</span>
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-pressed={value === null}
        className={cn(
          "rounded-full px-2 py-0.5 transition-colors",
          value === null ? "bg-neon-soft text-neon" : "text-muted-2 hover:bg-surface-2",
        )}
      >
        Auto
      </button>
      {CHAT_MODEL_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(value === key ? null : key)}
          aria-pressed={value === key}
          title={CHAT_MODEL_OPTIONS[key].description}
          className={cn(
            "rounded-full px-2 py-0.5 transition-colors",
            value === key ? "bg-neon-soft text-neon" : "text-muted-2 hover:bg-surface-2",
          )}
        >
          {CHAT_MODEL_OPTIONS[key].label}
        </button>
      ))}
    </div>
  );
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

/* ── Action chips ────────────────────────────────────────────────────── */

/**
 * The three AI actions. Extracted from the welcome column so the same list can
 * render in the strip above the input bar once a transcript exists (QA F88).
 *
 * The Refresh Task Map chip that used to live here moved to the Task Map itself
 * (RefreshTaskMapButton, mounted from progress-view.tsx) - it acts on the task
 * board, not the chat, and reads oddly homed in a general-purpose assistant.
 */
export function ActionChips({
  onRun,
}: {
  /** Sends the action's chat trigger; `display` is what the transcript shows (QA F15). */
  onRun: (trigger: string, display: string, deep?: boolean) => void;
}) {
  return (
    // Two-by-two below lg so all three land above the fold in the mobile sheet;
    // one column in the desktop rail, which is only 380px wide (QA F94).
    <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-col">
      {buildProactiveActions().map((action) => {
        return (
          <button
            key={action.id}
            onClick={() => onRun(action.trigger, action.label, action.deep)}
            className="group flex flex-col items-start gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-3 text-left transition-all duration-150 hover:border-border-strong hover:bg-surface-3 active:scale-[0.98] lg:flex-row lg:items-center lg:gap-3"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/[0.04] text-foreground/70 transition-all duration-150">
              <Icon name={action.icon} className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground">{action.label}</p>
              {/* Two lines, not `truncate`: the longest sublabels clipped
                  mid-phrase on a single line (QA F88). */}
              <p className="line-clamp-2 text-[11px] text-muted">{action.sublabel}</p>
            </div>
            <Icon
              name="ArrowRight"
              className="hidden h-3.5 w-3.5 shrink-0 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100 lg:block"
            />
          </button>
        );
      })}
    </div>
  );
}

/* ── Proactive welcome (CLIENT_USER initial view) ────────────────────── */

function ProactiveWelcome({
  clientName,
  userName,
  hasGoogleIntegration,
  send,
}: {
  clientName: string;
  userName?: string;
  hasGoogleIntegration: boolean;
  send: (t: string, display?: string) => void;
}) {
  // Kept on the prop chain (layout → dock → widget) - a Google connection used
  // to change an action chip's icon to a globe, but nothing in any remaining
  // action ever looked outside the account (QA F50).
  void hasGoogleIntegration;
  const greeting = userName ? `Hi ${userName.split(" ")[0]}!` : `Welcome back!`;

  return (
    // `grow` (flex: 1 1 auto), not `flex-1` (flex: 1 1 0%). The bottom sheet is
    // now capped rather than fixed at 70dvh (CD-G8), so this region's container
    // can have an INDEFINITE height - and a zero flex-basis is exactly the case
    // where engines disagree about what an auto-height column flex container
    // should size to. Chrome resolves it to the max-content contribution (so
    // both spellings measure identically there), but `auto` states the intent
    // outright and does not depend on that rule. Behaviour in the fixed-height
    // desktop rail is unchanged: this is still the only growing item, so it
    // takes all the free space and scrolls once it runs out.
    <div className="flex grow flex-col gap-4 overflow-y-auto p-4">
      {/* Greeting */}
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-foreground/10 bg-foreground/[0.04] text-foreground/70">
          <Icon name="Sparkles" className="h-4 w-4" />
        </div>
        {/* One line: the greeting used to run to two paragraphs, which on a
            phone filled the sheet on its own (QA F94). */}
        <div className="rounded-md border border-border bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
          <p className="font-medium">{greeting} I&apos;m your AI Copilot for <strong>{clientName}</strong>.</p>
          {/* Describing a task no longer needs its own card - the main input
              below does it, either conversationally or via /add-task (QA CD-L1). */}
          <p className="mt-1 text-xs text-muted">
            Describe a task, type <code className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[10px]">/</code> for
            commands, or <code className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[10px]">@</code> to focus on
            one of your agents.
          </p>
        </div>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-2 px-1">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[10px] text-muted-2">or run an AI action</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <ActionChips onRun={send} />

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
    // `grow` for the same reason as ProactiveWelcome - see the note there.
    <div className="flex grow flex-col items-center justify-center gap-3 px-4 py-8 text-center">
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
  /** Signed-in viewer. Scopes the persisted transcript so a shared tab cannot
   *  hand one user's conversation to the next (staff→client leaks internal text). */
  viewerUid: string;
  clientName: string;
  /** When true the chat panel opens automatically on mount (CLIENT_USER login). */
  defaultOpen?: boolean;
  /** Display name of the currently logged-in user (for personalised greeting). */
  userName?: string;
  /** Whether this client has an active Google integration (shows Gmail chip). */
  hasGoogleIntegration?: boolean;
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
  viewerUid,
  clientName,
  defaultOpen = false,
  userName,
  hasGoogleIntegration = false,
  docked = false,
  onCollapse,
  floatingPosition = "bottom-6 right-6",
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  // The AI actions strip above the input bar, once a transcript exists. Starts
  // collapsed so it never crowds the answers (QA F88).
  const [actionsOpen, setActionsOpen] = useState(false);
  // Docked mode is permanently open and never shows the floating bubble.
  const panelOpen = docked || open;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onBrandingChange = useCallback(() => router.refresh(), [router]);
  const onTasksCreated = useCallback(() => router.refresh(), [router]);

  const {
    messages, input, setInput, send, sendAddTask, streaming, error, reset,
    focusAgent, setFocusAgent, preferredModel, setPreferredModel,
  } = useCopilot(clientId, viewerUid, onBrandingChange, onTasksCreated);

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

  /* ── @mention roster ──────────────────────────────────────────────── */
  // Fetched independently of a chat turn - the `@` dropdown has to be ready
  // the moment the client starts typing, not after their first message lands.
  const [mentionableAgents, setMentionableAgents] = useState<MentionableAgent[]>([]);
  // The focused chip's mark, resolved from the roster rather than stored on the
  // focus itself, so both ways of setting focus reach the same answer.
  const focusAgentPlatform: SocialPlatform | null = focusAgent
    ? mentionableAgents.find((a) => a.id === focusAgent.id)?.platform ?? null
    : null;
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/clients/${clientId}/agents/mentionable`)
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((data: { agents?: MentionableAgent[] }) => {
        if (!cancelled) setMentionableAgents(data.agents ?? []);
      })
      .catch(() => {
        /* dropdown just stays empty - chat itself still works */
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  /* ── `@` / `/` dispatch ───────────────────────────────────────────── */
  // Single-line input, so both triggers are read off the END of the current
  // value - the same simplification most single-line mention comboboxes make.
  // `@` fires on the trailing word anywhere; `/` only when it is the WHOLE
  // input so far, since a command is something typed first, not mid-sentence.
  const mentionQuery = /(?:^|\s)@(\S*)$/.exec(input)?.[1];
  const commandQuery = /^\/(\S*)$/.exec(input)?.[1];
  const mentionMatches =
    mentionQuery !== undefined
      ? mentionableAgents.filter((a) => a.displayName.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
      : [];
  const commandMatches =
    commandQuery !== undefined
      ? SLASH_COMMANDS.filter((c) => c.id.replace(/-/g, "").includes(commandQuery.toLowerCase().replace(/\//g, ""))).slice(0, 6)
      : [];
  // True autocomplete, not just a click-only list: which row Tab/Enter commits.
  // Reset to 0 on every keystroke (the input's onChange) since the filtered
  // list itself changes underneath whatever was highlighted.
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const activeMatches = mentionMatches.length > 0 ? mentionMatches : commandMatches;
  const clampedIndex = activeMatches.length > 0 ? highlightedIndex % activeMatches.length : 0;

  function pickMention(agent: MentionableAgent) {
    setFocusAgent({ id: agent.id, name: agent.displayName });
    // Strip the trailing "@query" the user was typing - the chip carries the
    // focus from here, so the literal "@" text would otherwise double it up.
    setInput((prev) => prev.replace(/(?:^|\s)@\S*$/, (m) => (m.startsWith(" ") ? " " : "")));
    setHighlightedIndex(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function pickCommand(cmd: SlashCommand) {
    setInput(cmd.scaffold ?? "/add-task ");
    setHighlightedIndex(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function submitCurrentInput() {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/add-task ")) {
      sendAddTask(trimmed.slice("/add-task ".length));
      return;
    }
    if (trimmed === "/add-task") return; // nothing to route yet
    send(input);
  }

  // Shared by both the form's submit and the input's Enter key - kept as one
  // function taking no event so it isn't tied to either handler's event type.
  // Commits whichever row is HIGHLIGHTED, not always the top one - arrow keys
  // (handleKeyDown) move `highlightedIndex` before this ever fires.
  function submitOrDispatch() {
    // A dropdown open commits the highlighted suggestion rather than sending
    // half-typed "@" or "/" text as a literal message.
    if (mentionMatches.length > 0) return pickMention(mentionMatches[clampedIndex]);
    if (commandMatches.length > 0) return pickCommand(commandMatches[clampedIndex]);
    submitCurrentInput();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitOrDispatch();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Arrow/Tab only apply while a dropdown is actually open - otherwise
    // Tab should do its normal browser thing (move focus to the next control).
    if (activeMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((i) => (i + 1) % activeMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((i) => (i - 1 + activeMatches.length) % activeMatches.length);
        return;
      }
      if (e.key === "Tab") {
        // Tab commits without sending - lets the client keep typing to
        // complete the sentence (an @mention leaves the input empty to type
        // into; a /command's scaffold ends mid-sentence on purpose).
        e.preventDefault();
        submitOrDispatch();
        return;
      }
    }
    if (e.key === "Escape" && (mentionQuery !== undefined || commandQuery !== undefined)) {
      // Drop the trigger character so re-pressing Escape doesn't just reopen it.
      setInput((prev) => prev.replace(/(?:^|\s)@\S*$/, "").replace(/^\/\S*$/, ""));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitOrDispatch();
    }
  }

  return (
    <>
      {/* Floating bubble - hidden in docked mode */}
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

          {/* Header - single title; hairline divider, no fill (surface ladder).
              Sizes to its own content. This used to be pinned to h-[53px] to
              match the border-box height of the page header the rail sat beside,
              so the two border-b hairlines read as one continuous line; that
              header no longer exists, which left the number aligned to nothing.
              py-3 around the two-line title block (16px + mt-1 + 9px, all
              leading-none) lands within a pixel of the old height anyway, and
              the 28px controls opposite it are shorter, so they never drive it. */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
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
                clientName={clientName}
                userName={userName}
                hasGoogleIntegration={hasGoogleIntegration}
                send={send}
              />
            ) : (
              <ChatEmptyState clientName={clientName} send={send} />
            )
          ) : (
            /* `grow` for the same reason as ProactiveWelcome - see the note there. */
            <div className="flex grow flex-col gap-3 overflow-y-auto p-4">
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
                        // The model writes markdown - the system prompt is itself
                        // authored in it and the flagship actions ask for
                        // multi-section deliverables - so a pre-wrapped span put
                        // asterisks, hash marks and table pipes on screen (QA F89).
                        // renderSectionBody escapes before formatting, so model
                        // output cannot inject markup; it is the same renderer the
                        // documents view uses.
                        <div dangerouslySetInnerHTML={{ __html: renderSectionBody(msg.content) }} />
                      ) : (
                        // `display` is the action's own label when the chip's
                        // hidden trigger is what was actually sent (QA F15).
                        <span style={{ whiteSpace: "pre-wrap" }}>{msg.display ?? msg.content}</span>
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

          {/* AI actions strip - the four actions and the quick-add form used to
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
                  <ActionChips onRun={send} />
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

          {/* Focused-agent chip - a bias, not a lock (chat/route.ts's FOCUSED
              AGENT block still answers anything else asked). Persists across
              turns AND reloads (sessionStorage) until cleared here, by picking
              a different @mention, or by telling the copilot in plain text to
              switch agents / go back to general (set_agent_focus). */}
          {focusAgent && (
            <div className="mx-3 mb-2 flex w-fit items-center gap-1.5 rounded-full border border-neon/30 bg-neon-soft px-2.5 py-1 text-[11px] text-neon">
              {/* The same mark the picker row wore, looked up rather than
                  carried - see FocusAgent. The @ stays when the agent targets
                  no platform, and when focus was set by the copilot naming an
                  agent that is not on this client's roster. */}
              {focusAgentPlatform ? (
                <SocialPlatformMark platform={focusAgentPlatform} className="h-3 w-3" />
              ) : (
                <Icon name="AtSign" className="h-3 w-3" />
              )}
              Focused on {focusAgent.name}
              <button
                type="button"
                onClick={() => setFocusAgent(null)}
                aria-label="Clear focused agent"
                className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-neon/20"
              >
                <Icon name="X" className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Input bar - `relative` hosts the @mention / /command dropdown,
              which floats ABOVE the bar (bottom-full) since the bar itself
              sits at the very bottom of the panel. */}
          <div className="relative shrink-0">
            {(mentionMatches.length > 0 || commandMatches.length > 0) && (
              <div
                role="listbox"
                className="absolute bottom-full left-3 right-3 z-10 mb-1 max-h-56 overflow-y-auto rounded-md border border-border bg-surface shadow-lg"
              >
                {mentionQuery !== undefined &&
                  mentionMatches.map((a, i) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => pickMention(a)}
                      onMouseEnter={() => setHighlightedIndex(i)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
                        i === clampedIndex ? "bg-surface-2" : "hover:bg-surface-2",
                      )}
                    >
                      {/* AF-20: the platform this agent posts to, so tagging
                          one says what you are about to get. An agent that
                          targets no platform (Landing Builder) keeps the stored
                          icon it has always had - the route sends null rather
                          than a nearest guess. */}
                      {a.platform ? (
                        <SocialPlatformMark platform={a.platform} className="h-3.5 w-3.5 shrink-0 text-muted-2" />
                      ) : (
                        <Icon name={a.icon} className="h-3.5 w-3.5 shrink-0 text-muted-2" />
                      )}
                      <span className="flex-1 truncate text-xs text-foreground">{a.displayName}</span>
                    </button>
                  ))}
                {commandQuery !== undefined &&
                  commandMatches.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => pickCommand(c)}
                      onMouseEnter={() => setHighlightedIndex(i)}
                      className={cn(
                        "flex w-full flex-col items-start px-3 py-2 text-left transition-colors",
                        i === clampedIndex ? "bg-surface-2" : "hover:bg-surface-2",
                      )}
                    >
                      <span className="font-mono text-xs text-foreground">{c.label}</span>
                      <span className="text-[11px] text-muted-2">{c.hint}</span>
                    </button>
                  ))}
              </div>
            )}
            <ModelPicker value={preferredModel} onChange={setPreferredModel} />
            <form
              onSubmit={handleSubmit}
              className="flex items-center gap-2 border-t border-border px-3 py-3"
            >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setHighlightedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={
                showProactiveWelcome
                  ? "Describe a task, or ask a question…"
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
