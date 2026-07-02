"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Button, Input, Textarea, Select, Label, Badge } from "@/components/ui";
import { Icon, AGENT_ICONS } from "@/components/icon";
import {
  createDraftAgentAction,
  saveAgentDraftAction,
  publishAgentAction,
  unpublishAgentAction,
  deleteAgentAction,
  testRunAgentAction,
} from "@/lib/actions";
import { cn, relativeTime } from "@/lib/utils";
import type { Agent, AgentCapability, AgentField, Client } from "@/lib/types";
import type { TestRunResult } from "@/lib/agents/run";

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (balanced)" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 (most capable)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
];

const OUTPUT_KINDS: { id: Agent["outputKind"]; label: string; hint: string }[] = [
  { id: "instagram_posts", label: "Instagram posts", hint: "Structured posts: caption, hashtags, visual brief" },
  { id: "email", label: "Email", hint: "Subject + body marketing email" },
  { id: "article", label: "Article", hint: "Long-form blog/article" },
  { id: "social_posts", label: "Social posts", hint: "Batch of short social posts" },
  { id: "freeform", label: "Freeform text", hint: "Any text output" },
];

const CAPS: { id: AgentCapability; label: string; hint: string }[] = [
  { id: "use_brand_voice", label: "Use brand voice", hint: "Ground output on the client's brand voice" },
  { id: "use_transcripts", label: "Use meetings", hint: "Feed in recent client meeting context" },
  { id: "create_assets", label: "Save as assets", hint: "Store outputs in the client's library" },
  { id: "generate_images", label: "Generate images", hint: "Create a real image for each Instagram post from its visual brief" },
  { id: "email_client", label: "Email the client", hint: "Deliver the result to the client's inbox" },
];

const COLORS = ["#FF6B2C", "#6b9fd4", "#b8b8bf", "#d9a13d", "#e5484d", "#ff9d5d"];

type SaveState = "idle" | "saving" | "saved" | "error";

type DraftFields = Pick<
  Agent,
  "name" | "description" | "icon" | "color" | "model" | "outputKind" | "systemPrompt" | "capabilities" | "fields" | "shared"
>;

export function AgentBuilder({ agent, clients }: { agent?: Agent; clients: Client[] }) {
  const router = useRouter();
  const [id, setId] = useState<string | undefined>(agent?.id);
  const [status, setStatus] = useState<Agent["status"]>(agent ? agent.status ?? "published" : "draft");

  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [icon, setIcon] = useState(agent?.icon ?? "Sparkles");
  const [color, setColor] = useState(agent?.color ?? "#FF6B2C");
  const [model, setModel] = useState(agent?.model ?? "claude-sonnet-4-6");
  const [outputKind, setOutputKind] = useState<Agent["outputKind"]>(agent?.outputKind ?? "freeform");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [capabilities, setCapabilities] = useState<AgentCapability[]>(
    agent?.capabilities ?? ["generate", "use_brand_voice", "create_assets", "generate_images"],
  );
  const [fields, setFields] = useState<AgentField[]>(agent?.fields ?? [{ key: "topic", label: "Topic", type: "text", required: true }]);
  const [shared, setShared] = useState(agent?.shared ?? true);

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(agent ? agent.updatedAt : null);
  const [busy, setBusy] = useState<"publish" | "unpublish" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const config: DraftFields = { name, description, icon, color, model, outputKind, systemPrompt, capabilities, fields, shared };
  const configKey = JSON.stringify(config);
  const idRef = useRef(id);
  // eslint-disable-next-line react-hooks/refs -- intentional: keeps ref in sync with latest id to avoid stale closures in async callbacks
  idRef.current = id;
  const firstRender = useRef(true);

  // Lazy create + debounced autosave. Skips the initial mount so we don't
  // persist an empty draft just for opening the page.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        if (!idRef.current) {
          const res = await createDraftAgentAction(config);
          if (cancelled) return;
          idRef.current = res.id;
          setId(res.id);
          // Update the URL without a navigation/remount so editing stays smooth.
          window.history.replaceState(null, "", `/agents/${res.id}`);
        } else {
          await saveAgentDraftAction(idRef.current, config);
        }
        if (cancelled) return;
        setSaveState("saved");
        setSavedAt(Date.now());
      } catch {
        if (!cancelled) setSaveState("error");
      }
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  function toggleCap(c: AgentCapability) {
    setCapabilities((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));
  }
  function updateField(i: number, patch: Partial<AgentField>) {
    setFields((f) => f.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function addField() {
    setFields((f) => [...f, { key: `field_${f.length + 1}`, label: "New field", type: "text" }]);
  }
  function removeField(i: number) {
    setFields((f) => f.filter((_, idx) => idx !== i));
  }

  async function publish() {
    setError(null);
    if (!name.trim()) return setError("Give your agent a name.");
    if (!systemPrompt.trim()) return setError("Add a system prompt — this is the agent's brain.");
    setBusy("publish");
    try {
      let agentId = idRef.current;
      if (!agentId) {
        agentId = (await createDraftAgentAction(config)).id;
        setId(agentId);
      }
      await publishAgentAction(agentId, config);
      router.push("/agents");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publish failed");
      setBusy(null);
    }
  }

  async function unpublish() {
    if (!id) return;
    setBusy("unpublish");
    try {
      await unpublishAgentAction(id);
      setStatus("draft");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!id) return router.push("/agents");
    if (!confirm("Delete this agent? This cannot be undone.")) return;
    setBusy("delete");
    await deleteAgentAction(id);
    router.push("/agents");
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        {/* Status / save bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-4 py-2.5">
          <div className="flex items-center gap-2">
            {status === "draft" ? (
              <Badge tone="warning">
                <Icon name="PencilRuler" className="h-3 w-3" /> In development
              </Badge>
            ) : (
              <Badge tone="neon">
                <Icon name="CircleCheck" className="h-3 w-3" /> Live
              </Badge>
            )}
          </div>
          <SaveIndicator state={saveState} savedAt={savedAt} />
        </div>

        {/* Identity */}
        <Card className="space-y-4">
          <CardTitle>Identity</CardTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Instagram + Email Agent" />
            </div>
            <div>
              <Label>Model</Label>
              <Select value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this agent do?" className="min-h-[64px]" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Icon</Label>
              <div className="flex flex-wrap gap-1.5">
                {AGENT_ICONS.map((ic) => (
                  <button
                    key={ic}
                    type="button"
                    onClick={() => setIcon(ic)}
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-md border transition-colors",
                      icon === ic ? "border-neon bg-neon-soft text-neon" : "border-border text-muted hover:text-foreground",
                    )}
                  >
                    <Icon name={ic} className="h-4 w-4" />
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label>Accent</Label>
              <div className="flex flex-wrap gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={cn("h-9 w-9 rounded-full border-2 transition-transform", color === c ? "scale-110 border-white" : "border-transparent")}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* Brain */}
        <Card className="space-y-4">
          <CardTitle>The brain</CardTitle>
          <div>
            <Label>Output type</Label>
            <Select value={outputKind} onChange={(e) => setOutputKind(e.target.value as Agent["outputKind"])}>
              {OUTPUT_KINDS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} — {o.hint}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>System prompt</Label>
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a senior social strategist… Describe the agent's role, rules, and quality bar."
              className="min-h-[160px] font-mono text-[13px]"
            />
            <p className="mt-1.5 text-xs text-muted-2">The client&apos;s brand voice &amp; meeting context are injected automatically when those capabilities are on.</p>
          </div>
        </Card>

        {/* Inputs */}
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <CardTitle>Inputs collected at run time</CardTitle>
            <Button size="sm" variant="outline" onClick={addField}>
              <Icon name="Plus" className="h-3.5 w-3.5" />
              Add field
            </Button>
          </div>
          <div className="space-y-3">
            {fields.map((f, i) => (
              <div key={i} className="rounded-md border border-border bg-surface-2 p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_120px_auto]">
                  <Input value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} placeholder="Label" />
                  <Input value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} placeholder="key" className="font-mono text-xs" />
                  <Select value={f.type} onChange={(e) => updateField(i, { type: e.target.value as AgentField["type"] })}>
                    <option value="text">Text</option>
                    <option value="textarea">Long text</option>
                    <option value="number">Number</option>
                    <option value="select">Select</option>
                  </Select>
                  <button onClick={() => removeField(i)} className="flex items-center justify-center px-2 text-muted-2 hover:text-danger">
                    <Icon name="Trash2" className="h-4 w-4" />
                  </button>
                </div>
                {f.type === "select" && (
                  <Input
                    className="mt-2 text-xs"
                    placeholder="Options, comma separated"
                    value={Array.isArray(f.options) ? f.options.join(", ") : (f.options ?? "")}
                    onChange={(e) => updateField(i, { options: e.target.value as unknown as string[] })}
                  />
                )}
                <label className="mt-2 flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={!!f.required} onChange={(e) => updateField(i, { required: e.target.checked })} className="accent-[var(--neon)]" />
                  Required
                </label>
              </div>
            ))}
            {fields.length === 0 && <p className="text-sm text-muted-2">No inputs — the agent runs purely on client context.</p>}
          </div>
        </Card>
      </div>

      {/* Sidebar: capabilities + test + actions */}
      <div className="space-y-6">
        <Card className="space-y-3">
          <CardTitle>Capabilities</CardTitle>
          {CAPS.map((c) => {
            const on = capabilities.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleCap(c.id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors",
                  on ? "border-neon/40 bg-neon-soft" : "border-border hover:border-border-strong",
                )}
              >
                <div className={cn("mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border", on ? "border-neon bg-neon text-[#141414]" : "border-border-strong")}>
                  {on && <Icon name="Check" className="h-3.5 w-3.5" />}
                </div>
                <div>
                  <p className="text-sm font-medium">{c.label}</p>
                  <p className="text-xs text-muted-2">{c.hint}</p>
                </div>
              </button>
            );
          })}
        </Card>

        <TestPanel
          clients={clients}
          fields={fields}
          config={config}
          showImages={capabilities.includes("generate_images")}
        />

        <Card className="space-y-3">
          <CardTitle>Settings</CardTitle>
          <Toggle label="Shared with team" hint="All employees can run it once published" value={shared} onChange={setShared} />
        </Card>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex flex-col gap-2">
          {status === "draft" ? (
            <Button onClick={publish} loading={busy === "publish"}>
              <Icon name="Rocket" className="h-4 w-4" />
              Publish agent
            </Button>
          ) : (
            <Button variant="outline" onClick={unpublish} loading={busy === "unpublish"}>
              <Icon name="Undo2" className="h-4 w-4" />
              Unpublish to draft
            </Button>
          )}
          <Button variant="danger" onClick={remove} loading={busy === "delete"}>
            <Icon name="Trash2" className="h-4 w-4" />
            Delete agent
          </Button>
        </div>
      </div>
    </div>
  );
}

function SaveIndicator({ state, savedAt }: { state: SaveState; savedAt: number | null }) {
  if (state === "saving") return <span className="text-xs text-muted-2">Saving…</span>;
  if (state === "error") return <span className="text-xs text-danger">Couldn&apos;t save</span>;
  if (state === "saved" || savedAt)
    return (
      <span className="flex items-center gap-1 text-xs text-muted-2">
        <Icon name="Check" className="h-3 w-3 text-neon" /> Saved{savedAt ? ` · ${relativeTime(savedAt)}` : ""}
      </span>
    );
  return null;
}

function TestPanel({
  clients,
  fields,
  config,
  showImages,
}: {
  clients: Client[];
  fields: AgentField[];
  config: DraftFields;
  showImages: boolean;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [withImages, setWithImages] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function set(key: string, v: string) {
    setValues((s) => ({ ...s, [key]: v }));
  }

  async function run() {
    setError(null);
    if (!clientId) return setError("Pick a client to test against.");
    setRunning(true);
    setResult(null);
    try {
      const res = await testRunAgentAction({ config, clientId, values, withImages });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <CardTitle>Test run</CardTitle>
        <Badge tone="neutral">
          <Icon name="ShieldCheck" className="h-3 w-3" /> Sandbox
        </Badge>
      </div>
      <p className="text-xs text-muted-2">Runs against a real client, but nothing is emailed or saved.</p>

      <div>
        <Label>Client</Label>
        <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          {clients.length === 0 && <option value="">No clients available</option>}
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      {fields.map((f) => (
        <div key={f.key}>
          <Label>
            {f.label}
            {f.required && <span className="text-danger"> *</span>}
          </Label>
          {f.type === "textarea" ? (
            <Textarea placeholder={f.placeholder} value={values[f.key] ?? f.defaultValue ?? ""} onChange={(e) => set(f.key, e.target.value)} className="min-h-[64px]" />
          ) : f.type === "select" ? (
            <Select value={values[f.key] ?? f.defaultValue ?? ""} onChange={(e) => set(f.key, e.target.value)}>
              {(Array.isArray(f.options) ? f.options : []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              type={f.type === "number" ? "number" : "text"}
              placeholder={f.placeholder}
              value={values[f.key] ?? f.defaultValue ?? ""}
              onChange={(e) => set(f.key, e.target.value)}
            />
          )}
        </div>
      ))}

      {showImages && (
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={withImages} onChange={(e) => setWithImages(e.target.checked)} className="accent-[var(--neon)]" />
          Generate images (slower — needs SEGMIND_API_KEY)
        </label>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}

      <Button className="w-full" loading={running} onClick={run} disabled={clients.length === 0}>
        <Icon name="Play" className="h-4 w-4" />
        {running ? "Running…" : "Test run"}
      </Button>

      {result && <TestResult result={result} />}
    </Card>
  );
}

function TestResult({ result }: { result: TestRunResult }) {
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <Icon
          name={result.status === "failed" ? "TriangleAlert" : "Sparkles"}
          className={cn("h-4 w-4", result.status === "failed" ? "text-danger" : "text-neon")}
        />
        <p className="text-sm font-medium">{result.status === "failed" ? "Test run failed" : "Test output"}</p>
      </div>

      {/* Event trace */}
      <div className="space-y-1 rounded-md bg-surface-2 p-2.5">
        {result.events.map((ev, i) => (
          <p
            key={i}
            className={cn(
              "text-[11px] leading-relaxed",
              ev.level === "error" ? "text-danger" : ev.level === "success" ? "text-neon" : "text-muted-2",
            )}
          >
            {ev.message}
          </p>
        ))}
      </div>

      {result.error && <p className="text-xs text-danger">{result.error}</p>}

      {/* Instagram posts */}
      {result.posts && result.posts.length > 0 && (
        <div className="space-y-3">
          {result.posts.map((p, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border p-3">
              <p className="text-xs font-medium text-neon">Post {i + 1}</p>
              {result.images?.[i] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result.images[i] as string} alt={`Post ${i + 1} visual`} className="w-full rounded-md" />
              )}
              <p className="whitespace-pre-wrap text-sm">{p.caption}</p>
              <p className="text-xs text-muted">{p.hashtags.map((h) => "#" + h).join(" ")}</p>
              <p className="text-xs text-muted-2"><span className="font-medium">CTA:</span> {p.callToAction}</p>
              <p className="text-xs text-muted-2"><span className="font-medium">Visual:</span> {p.imageConcept}</p>
            </div>
          ))}
        </div>
      )}

      {/* Text output */}
      {result.text && (
        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 text-[13px] leading-relaxed">{result.text}</pre>
      )}
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!value)} className="flex w-full items-center justify-between">
      <div className="text-left">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-2">{hint}</p>
      </div>
      <div className={cn("relative h-6 w-11 rounded-full transition-colors", value ? "bg-neon" : "bg-surface-3")}>
        <div className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-primary transition-transform", value ? "translate-x-5" : "translate-x-0.5")} />
      </div>
    </button>
  );
}
