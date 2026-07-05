"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardTitle, Input, Label, Select, Spinner, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { submitManagedJobAction } from "@/lib/actions";
import type { ContextItem, ManagedTaskType } from "@/lib/types";

const TASK_TYPES: Array<{ value: ManagedTaskType; label: string }> = [
  { value: "social_post", label: "Social posts (IG/TikTok)" },
  { value: "newsletter_issue", label: "Newsletter issue" },
  { value: "blog_article", label: "Blog article" },
  { value: "landing_page", label: "Landing page" },
];

/**
 * Submission form for jobs on the external agent service (karos-agents lab
 * products). Renders the per-task-type brief fields, lets staff attach
 * existing context files as job inputs, and links to the mirrored job page.
 */
export function ManagedJobForm({
  clientId,
  contextItems,
}: {
  clientId: string;
  contextItems: ContextItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [taskType, setTaskType] = useState<ManagedTaskType>("social_post");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  function buildBrief(): Record<string, unknown> {
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== ""));
    if (taskType === "social_post" && clean.count) return { ...clean, count: Number(clean.count) };
    return clean;
  }

  function submit() {
    setError(null);
    if (taskType === "blog_article" && !fields.topic?.trim()) {
      setError("Topic is required.");
      return;
    }
    if (taskType === "landing_page" && !fields.page_goal?.trim()) {
      setError("Page goal is required.");
      return;
    }
    startTransition(async () => {
      const result = await submitManagedJobAction({
        clientId,
        taskType,
        brief: buildBrief(),
        contextItemIds: selectedFiles,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.jobId) router.push(`/jobs/${result.jobId}`);
    });
  }

  function toggleFile(id: string) {
    setSelectedFiles((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  return (
    <Card>
      <CardTitle className="mb-1">Managed products</CardTitle>
      <p className="mb-4 text-xs text-muted">
        Runs a karos-agents lab product on the agent service. Deliverables come back as drafts for review.
      </p>

      <div className="space-y-3">
        <div>
          <Label htmlFor="managed-task-type">Product</Label>
          <Select
            id="managed-task-type"
            value={taskType}
            onChange={(e) => {
              setTaskType(e.target.value as ManagedTaskType);
              setFields({});
            }}
          >
            {TASK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>

        {taskType === "social_post" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="mj-count">Posts</Label>
                <Input id="mj-count" type="number" min={1} max={10} placeholder="3" value={fields.count ?? ""} onChange={set("count")} />
              </div>
              <div>
                <Label htmlFor="mj-platform">Platform</Label>
                <Select id="mj-platform" value={fields.platform ?? "both"} onChange={set("platform")}>
                  <option value="both">Instagram + TikTok</option>
                  <option value="instagram">Instagram</option>
                  <option value="tiktok">TikTok</option>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="mj-topic">Topic (optional)</Label>
              <Input id="mj-topic" placeholder="e.g. spring collection launch" value={fields.topic ?? ""} onChange={set("topic")} />
            </div>
          </>
        )}

        {taskType === "newsletter_issue" && (
          <div>
            <Label htmlFor="mj-theme">Issue theme (optional)</Label>
            <Input id="mj-theme" placeholder="e.g. monthly product roundup" value={fields.issue_theme ?? ""} onChange={set("issue_theme")} />
          </div>
        )}

        {taskType === "blog_article" && (
          <>
            <div>
              <Label htmlFor="mj-blog-topic">Topic</Label>
              <Input id="mj-blog-topic" required placeholder="What should the article cover?" value={fields.topic ?? ""} onChange={set("topic")} />
            </div>
            <div>
              <Label htmlFor="mj-keyword">Target keyword (optional)</Label>
              <Input id="mj-keyword" value={fields.target_keyword ?? ""} onChange={set("target_keyword")} />
            </div>
          </>
        )}

        {taskType === "landing_page" && (
          <>
            <div>
              <Label htmlFor="mj-goal">Page goal</Label>
              <Input id="mj-goal" required placeholder="e.g. collect demo bookings" value={fields.page_goal ?? ""} onChange={set("page_goal")} />
            </div>
            <div>
              <Label htmlFor="mj-offer">Offer (optional)</Label>
              <Input id="mj-offer" value={fields.offer ?? ""} onChange={set("offer")} />
            </div>
          </>
        )}

        <div>
          <Label htmlFor="mj-notes">Notes for the agent (optional)</Label>
          <Textarea id="mj-notes" rows={3} placeholder="Anything else the agent should know" value={fields.notes ?? ""} onChange={set("notes")} />
        </div>

        {contextItems.length > 0 && (
          <div>
            <Label>Attach input files</Label>
            <div className="mt-1 max-h-36 space-y-1 overflow-y-auto">
              {contextItems.map((item) => (
                <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={selectedFiles.includes(item.id)}
                    onChange={() => toggleFile(item.id)}
                    className="accent-neon"
                  />
                  <Icon name={item.kind === "image" ? "Image" : "FileText"} className="h-3.5 w-3.5 text-muted-2" />
                  <span className="truncate">{item.name}</span>
                  {item.note && <span className="truncate text-muted-2">— {item.note}</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}

        <Button onClick={submit} disabled={pending} className="w-full">
          {pending ? <Spinner className="h-4 w-4" /> : <Icon name="Rocket" className="h-4 w-4" />}
          {pending ? "Submitting…" : "Run managed job"}
        </Button>
      </div>
    </Card>
  );
}
