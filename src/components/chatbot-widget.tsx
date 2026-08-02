"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { ingestCustomUserTaskAction } from "@/lib/actions";
// Quoted from the pricing home, off the same constant the swarm route charges.
import { taskMapRefreshPrice } from "@/lib/credits";
import { renderSectionBody } from "@/lib/doc-render";
import { StrategyWarRoom } from "@/components/strategy-war-room";
import type { Client, ClientReport } from "@/lib/types";

/* ── Types ───────────────────────────────────────────────────────────── */

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * What the transcript shows in place of `content`. An action chip's hidden
   * instruction used to be rendered in the user bubble, so the client was
   * shown words they never wrote — including an order aimed at the model
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
  platform: string | null;
}

/** A focused-agent chip set by picking `@AgentName` — biases, not locks, the chat. */
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
/** Cap what we write back — a long thread is not worth a quota error. */
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
  /**
   * What one press of THIS chip costs the reader, when it costs them anything.
   * Only Refresh Task Map charges per press; the other three send an ordinary
   * chat turn, which is priced by the input bar's own message charge and not by
   * the chip. Null for a reader who is not billed (staff, View as Client).
   */
  price?: string | null;
  /** Chat message this chip sends. Omitted for chips handled by a dedicated UI. */
  trigger?: string;
  color: string;
  /**
   * Opts into Sonnet instead of the copilot's default Haiku model — this is a
   * plain chatbot, so most turns (including a focused-agent conversation) run
   * cheap. These three run multi-step tool orchestration over a full strategy
   * write-up, not a quick Q&A turn, so they ask for the stronger model.
   */
  deep?: boolean;
}

function buildProactiveActions(viewerIsBilled: boolean): ProactiveAction[] {
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
      // THE ANNOUNCE. Pressing this chip does not open a confirmation — the War
      // Room mounts and the debate (six model calls) starts immediately, so the
      // charge is committed by the press itself. The price therefore belongs on
      // the chip, quoted from the constant /api/tasks/generate-swarm charges
      // from, in the same voice Audience Simulation uses.
      price: taskMapRefreshPrice(viewerIsBilled),
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
      deep: true,
    },
    {
      id: "brand_audit",
      icon: "Search",
      label: "Brand Visibility Audit",
      sublabel: "Surface presence gaps and push optimization tasks",
      trigger:
        "Run a brand visibility and market presence audit. Identify gaps in our brand positioning and generate specific optimization action items.",
      color: "#d9a13d",
      deep: true,
    },
    {
      // "Queue" claimed an execution step this path never performs: the only
      // write is pending task cards, and a run starts when a human later moves
      // a card into In Progress (QA F91).
      //
      // "Dispatch" was the same mistake one layer up (A3): it named the
      // machinery — a batch being sent somewhere — on a chip a client presses.
      // The label says what the client ends up with. Same rename as the board
      // chip in tasks-board.tsx; neither surface branches by role, so there is
      // no staff naming to preserve here.
      id: "content_dispatch",
      icon: "Zap",
      label: "Content Plan",
      sublabel: "Propose this week's content plan as ready-to-run tasks",
      trigger:
        "Propose which Karos managed products (social posts, newsletter, blog article, landing page) to plan for content creation this week, and suggest a concrete content plan I can turn into tasks.",
      color: "#e5484d",
      deep: true,
    },
  ];
}

/**
 * The `/` command palette. Each entry either inserts a scaffold sentence into
 * the input — the same idiom the action chips' `trigger` strings already use,
 * so completing it and sending is an ordinary chat turn the new capability-
 * matrix tools (find_output/edit_output/run_agent_now/reschedule_output/
 * provide_feedback, chat/route.ts) answer — or, for `/add-task`, is handled
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
    scaffold: "I'd like to revise one of my generated posts — here's what to change: ",
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
 * The "View" link on a task the copilot just added — written as MARKDOWN,
 * because an assistant turn is rendered through `renderSectionBody`, which
 * escapes the text first and then formats it, and turns a link into an anchor
 * only when the href is http(s), mailto, a fragment, or a genuinely same-origin
 * path (`isSafeHref`).
 *
 * KEYED ON `?task=`, NOT `?owner=`, and that is a ruling rather than a
 * shorthand. The board's two tabs are split by owner and are DISJOINT:
 * `?owner=client` selects the client tab and everything else — a bare `/tasks`
 * included — selects "karos", so a link that guesses lands the reader on a board
 * that does not hold the card it just named. `?task=` makes the board resolve
 * the tab itself (`ownerTab(inferOwner(linkedTask))`, tasks-board.tsx) and open
 * the ticket with it, so neither the owner→tab mapping nor the owner inference
 * for a task with no stored owner is copied here. `taskBoardHref` in
 * client-home-overview.tsx reached the same answer against the same two rules;
 * this is that answer applied to the copilot, not a second opinion.
 *
 * WHY THE COPILOT NEEDS THE LINK AND QuickAddTaskBar DOES NOT. F65 put the named
 * announcement on both, and the two recover differently: the quick-add bar sits
 * ON the board and moves it to the right tab through `onAdded`, while the
 * copilot is a dock over whatever page the reader is on. Without this the reply
 * named a card with no way to reach it — and the id needed to reach it was being
 * fetched from the action and thrown away.
 *
 * Empty string when the action returned no id, so the sentence just ends.
 */
function taskLink(taskId: string | undefined): string {
  return taskId ? ` [View](/tasks?task=${encodeURIComponent(taskId)})` : "";
}

/**
 * What the transcript says after `/add-task`.
 *
 * Pure and exported so the sentence and its link can be asserted as text and as
 * RENDERED markup — the two ways this can silently stop working are the id going
 * missing from the sentence and `renderSectionBody` declining to make an anchor
 * of it.
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
      : (result.error ?? "Couldn't add that task — try again.");
  }
  return `Added${result.title ? ` "${result.title}"` : ""} to your task board.${taskLink(result.taskId)}`;
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
  /** Set by picking `@AgentName` — sent as `focusAgentId` on every turn until cleared. */
  const [focusAgent, setFocusAgent] = useState<FocusAgent | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Scoped to viewer AND client: sessionStorage survives sign-out in the same
  // tab, and StaffCopilotDock writes under this prefix too — an unscoped key
  // let the next signed-in user restore the previous one's transcript, which
  // for a staff→client handover means internal-tier context in a client's pane.
  const storageKey = `${THREAD_KEY_PREFIX}${viewerUid || "anon"}.${clientId}`;
  /** Separate key, same scoping — the focus survives independently of clearing the transcript. */
  const focusStorageKey = `${THREAD_KEY_PREFIX}focus.${viewerUid || "anon"}.${clientId}`;
  /** Blocks the write-back below until the restore pass has run. */
  const hydratedRef = useRef(false);

  // Restore the transcript AND the focused agent for this client. Runs after
  // mount rather than in a lazy initializer so the server-rendered (empty)
  // markup and the first client render still agree. The two live in the same
  // effect so `hydratedRef` gates both write-backs from the same instant —
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
      /* unreadable / disabled storage — start clean */
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
      /* unreadable / disabled storage — starts unfocused */
    }
    hydratedRef.current = true;
  }, [storageKey, focusStorageKey]);

  // Write the focus back on every change once hydrated — unlike the transcript,
  // an explicit clear (null) DOES get persisted here: there is no dual-mount
  // "empty means not-yet-restored" ambiguity for a single id, only ever a
  // deliberate pick, a deliberate clear, or the restore pass itself.
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      if (focusAgent) sessionStorage.setItem(focusStorageKey, JSON.stringify(focusAgent));
      else sessionStorage.removeItem(focusStorageKey);
    } catch {
      /* quota or private mode — focus stays in memory for this session only */
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
    /**
     * @param display Shown in the user bubble instead of `text` — used by the
     * action chips, whose trigger is an instruction to the model, not a
     * sentence the client typed (QA F15). `text` is what the API receives.
     * @param deep Opts this one turn into Sonnet — the 3 substantive proactive
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
          }),
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
        // Set once the marker is seen, so a later chunk containing more
        // "<!--" text (unlikely, but the model writes free text) can't
        // re-trigger this and stomp a focus change the user made meanwhile.
        let focusMarkerSeen = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.includes("Branding guidelines updated")) brandingUpdated = true;
          if (chunk.includes("Created") && chunk.includes("task")) tasksCreated = true;
          accumulated += chunk;
          // The plain-text half of @mention focus (set_agent_focus, chat/route.ts):
          // the tool rides its answer inside an HTML comment the same way the
          // brand-sync block already does, so it renders invisibly
          // (stripPipelineMarkers, doc-render.ts) while still being sniffable
          // here, on the raw stream, before that stripping happens.
          if (!focusMarkerSeen) {
            const m = /<!--\s*COPILOT_FOCUS:([\s\S]*?)\s*-->/.exec(accumulated);
            if (m) {
              focusMarkerSeen = true;
              try {
                const payload = JSON.parse(m[1]) as { id: string; name: string } | null;
                setFocusAgent(payload);
              } catch {
                /* malformed payload — leave focus exactly as it was */
              }
            }
          }
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
    [clientId, messages, streaming, focusAgent, onBrandingChange, onTasksCreated, router],
  );

  /**
   * `/add-task` — the fast path `QuickTaskForm` used to front, reached from
   * the main input instead of a separate card. Deliberately NOT a chat turn:
   * it calls `ingestCustomUserTaskAction` directly (its own cheap Haiku
   * routing + dedup, its own `task_assist` credit charge), so folding task
   * creation into the main input doesn't also fold it into the pricier,
   * slower `chat_message` path. The transcript still shows it as a turn —
   * the user's literal command, then the routed result — so the two ways of
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
            m.id === assistantId ? { ...m, content: "Couldn't add that task — try again." } : m,
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
    focusAgent, setFocusAgent,
  };
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
 * The four AI actions. Extracted from the welcome column so the same list can
 * render in the strip above the input bar once a transcript exists (QA F88).
 *
 * Exported so the price on the Refresh Task Map chip can be asserted as RENDERED
 * MARKUP rather than as a string a component might or might not paint. It takes
 * no hooks and no router, so it renders standalone.
 */
export function ActionChips({
  onRun,
  onRefreshTaskMap,
  isAiProcessing,
  viewerIsBilled,
}: {
  /** Sends the action's chat trigger; `display` is what the transcript shows (QA F15). */
  onRun: (trigger: string, display: string, deep?: boolean) => void;
  onRefreshTaskMap: () => void;
  isAiProcessing?: boolean;
  /** `isBillableClientActor()` for this session — decides whether a price is quoted. */
  viewerIsBilled: boolean;
}) {
  return (
    // Two-by-two below lg so all four land above the fold in the mobile sheet;
    // one column in the desktop rail, which is only 380px wide (QA F94).
    <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-col">
      {buildProactiveActions(viewerIsBilled).map((action) => {
        const locked = action.id === "scan_inbox" && isAiProcessing;
        return (
          <button
            key={action.id}
            disabled={locked}
            onClick={() =>
              action.trigger ? onRun(action.trigger, action.label, action.deep) : onRefreshTaskMap()
            }
            title={locked ? "Karos Agents are already building your workspace strategy" : undefined}
            className={cn(
              "group flex flex-col items-start gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-3 text-left transition-all duration-150 lg:flex-row lg:items-center lg:gap-3",
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
              {/* Its own line rather than appended to the sublabel above, which
                  is `line-clamp-2` and would drop the price on a narrow chip. */}
              {action.price && !locked && (
                <p className="mt-0.5 text-[10px] text-muted-2">Costs {action.price} a press</p>
              )}
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
  onRefreshTaskMap,
  isAiProcessing,
  viewerIsBilled,
}: {
  clientName: string;
  userName?: string;
  hasGoogleIntegration: boolean;
  send: (t: string, display?: string) => void;
  /** Launches the multi-agent Strategy War Room instead of a single-shot chat scan. */
  onRefreshTaskMap: () => void;
  /** True while a background AI generation cycle is running — locks the Refresh Task Map chip. */
  isAiProcessing?: boolean;
  /** `isBillableClientActor()` for this session — decides whether a price is quoted. */
  viewerIsBilled: boolean;
}) {
  // Kept on the prop chain (layout → dock → widget) but no longer decorates the
  // Refresh Task Map chip: a Google connection changed the icon to a globe while
  // nothing in the run ever looked outside the account (QA F50).
  void hasGoogleIntegration;
  const greeting = userName ? `Hi ${userName.split(" ")[0]}!` : `Welcome back!`;

  return (
    // `grow` (flex: 1 1 auto), not `flex-1` (flex: 1 1 0%). The bottom sheet is
    // now capped rather than fixed at 70dvh (CD-G8), so this region's container
    // can have an INDEFINITE height — and a zero flex-basis is exactly the case
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
          {/* Describing a task no longer needs its own card — the main input
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

      <ActionChips
        onRun={send}
        onRefreshTaskMap={onRefreshTaskMap}
        isAiProcessing={isAiProcessing}
        viewerIsBilled={viewerIsBilled}
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
    // `grow` for the same reason as ProactiveWelcome — see the note there.
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
  /**
   * `isBillableClientActor()` for this session, resolved on the server.
   *
   * REQUIRED, with no default: the Refresh Task Map chip commits a charge the
   * moment it is pressed, and a mount site that forgot to answer would go back
   * to charging in silence — the exact defect this prop exists to close. So the
   * compiler asks every site rather than a default answering for it.
   */
  viewerIsBilled: boolean;
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
  viewerUid,
  clientName,
  viewerIsBilled,
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

  const {
    messages, input, setInput, send, sendAddTask, streaming, error, reset,
    focusAgent, setFocusAgent,
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
  // Fetched independently of a chat turn — the `@` dropdown has to be ready
  // the moment the client starts typing, not after their first message lands.
  const [mentionableAgents, setMentionableAgents] = useState<MentionableAgent[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/clients/${clientId}/agents/mentionable`)
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((data: { agents?: MentionableAgent[] }) => {
        if (!cancelled) setMentionableAgents(data.agents ?? []);
      })
      .catch(() => {
        /* dropdown just stays empty — chat itself still works */
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  /* ── `@` / `/` dispatch ───────────────────────────────────────────── */
  // Single-line input, so both triggers are read off the END of the current
  // value — the same simplification most single-line mention comboboxes make.
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
    // Strip the trailing "@query" the user was typing — the chip carries the
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

  // Shared by both the form's submit and the input's Enter key — kept as one
  // function taking no event so it isn't tied to either handler's event type.
  // Commits whichever row is HIGHLIGHTED, not always the top one — arrow keys
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
    // Arrow/Tab only apply while a dropdown is actually open — otherwise
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
        // Tab commits without sending — lets the client keep typing to
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
                onRefreshTaskMap={openWarRoom}
                isAiProcessing={client?.isAiProcessing}
                viewerIsBilled={viewerIsBilled}
              />
            ) : (
              <ChatEmptyState clientName={clientName} send={send} />
            )
          ) : (
            /* `grow` for the same reason as ProactiveWelcome — see the note there. */
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
                        // The model writes markdown — the system prompt is itself
                        // authored in it and the flagship actions ask for
                        // multi-section deliverables — so a pre-wrapped span put
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
                  <ActionChips
                    onRun={send}
                    onRefreshTaskMap={openWarRoom}
                    isAiProcessing={client?.isAiProcessing}
                    viewerIsBilled={viewerIsBilled}
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

          {/* Focused-agent chip — a bias, not a lock (chat/route.ts's FOCUSED
              AGENT block still answers anything else asked). Persists across
              turns AND reloads (sessionStorage) until cleared here, by picking
              a different @mention, or by telling the copilot in plain text to
              switch agents / go back to general (set_agent_focus). */}
          {focusAgent && (
            <div className="mx-3 mb-2 flex w-fit items-center gap-1.5 rounded-full border border-neon/30 bg-neon-soft px-2.5 py-1 text-[11px] text-neon">
              <Icon name="AtSign" className="h-3 w-3" />
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

          {/* Input bar — `relative` hosts the @mention / /command dropdown,
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
                      <Icon name={a.icon} className="h-3.5 w-3.5 shrink-0 text-muted-2" />
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
