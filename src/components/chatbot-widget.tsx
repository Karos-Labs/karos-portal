"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

function useCopilot(clientId: string, onBrandingChange: () => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: trimmed };
      const assistantId = crypto.randomUUID();

      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", content: "" },
      ]);
      setInput("");
      setStreaming(true);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      // Build the conversation history to send (user + assistant turns only, strip empty streaming placeholder)
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

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Check if the tool result passed through (server confirms branding changed)
          if (chunk.includes("Branding guidelines updated")) brandingUpdated = true;
          accumulated += chunk;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m)),
          );
        }

        if (brandingUpdated) onBrandingChange();
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          return;
        }
        const msg = e instanceof Error ? e.message : "Something went wrong. Try again.";
        setError(msg);
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      } finally {
        setStreaming(false);
      }
    },
    [clientId, messages, streaming, onBrandingChange],
  );

  return { messages, input, setInput, send, streaming, error };
}

/* ── Typing dots ─────────────────────────────────────────────────── */

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

/* ── Main component ──────────────────────────────────────────────── */

interface Props {
  clientId: string;
  clientName: string;
}

export function ChatbotWidget({ clientId, clientName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onBrandingChange = useCallback(() => router.refresh(), [router]);
  const { messages, input, setInput, send, streaming, error } = useCopilot(clientId, onBrandingChange);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, open]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
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
      {/* Floating bubble — hidden while panel is open */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-neon shadow-lg shadow-neon/30 transition-transform hover:scale-105 active:scale-95"
          aria-label="Open AI Copilot"
        >
          <Icon name="MessageCircle" className="h-6 w-6 text-black" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 flex h-[520px] w-[360px] flex-col overflow-hidden rounded-[20px] border border-border bg-surface shadow-2xl">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-2 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neon-soft">
                <Icon name="Bot" className="h-4 w-4 text-neon" />
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

          {/* Messages */}
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neon-soft">
                  <Icon name="Sparkles" className="h-6 w-6 text-neon" />
                </div>
                <div>
                  <p className="text-sm font-medium">Ask me anything</p>
                  <p className="mt-1 text-xs text-muted-2">
                    I have full context on {clientName}&apos;s report, brand, competitors, and
                    content history.
                  </p>
                </div>
                <div className="mt-1 flex flex-wrap justify-center gap-1.5">
                  {[
                    "What's our biggest weakness?",
                    "Summarise the report",
                    "Update our primary color",
                  ].map((prompt) => (
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
                        ? "bg-neon text-black"
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
              placeholder="Ask about performance, brand, competitors…"
              disabled={streaming}
              className="flex-1 rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-2 outline-none focus:border-neon/50 focus:ring-1 focus:ring-neon/30 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || streaming}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-neon text-black transition-opacity disabled:opacity-40"
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

      {/* Bounce keyframe (tiny inline style — avoids Tailwind config changes) */}
      <style>{`
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
      `}</style>
    </>
  );
}
