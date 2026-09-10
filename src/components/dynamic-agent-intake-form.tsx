"use client";

/**
 * Dynamic Agent Studio — client intake rendering (Phase 4).
 *
 * Renders whatever `DynamicAgentInputDef[]` an admin authored in the Agent
 * Studio's Input Schema Builder (input-schema-builder.tsx): text, textarea,
 * file, image, select. Client-side validates required fields, file TYPE
 * against `accept` and file SIZE against `maxSizeMb` before allowing submit,
 * with plain-English blocking errors —
 * mirroring the upload conventions `agent-input-files.tsx` already uses
 * (`POST /api/clients/[id]/context`), so file/image answers store the
 * uploaded object's reference, never the raw file, in the value handed back.
 *
 * This component render-only; it does not itself submit a job — the caller
 * (a dynamic-agent run page) supplies `onSubmit` and owns what happens with
 * the collected `Record<string, DynamicAgentInputValue>`.
 */

import { useId, useState } from "react";
import { Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { CreditPriceNote } from "@/components/credit-price-note";
import { creditsLabel, estimatedCreditsLabel } from "@/lib/credits";
import type { DynamicAgentInputDef, DynamicAgentInputValue } from "@/lib/types";

const DEFAULT_MAX_SIZE_MB = 20;

interface UploadedRef {
  id: string;
  url: string;
  name: string;
}

function isUploadedRef(value: unknown): value is UploadedRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UploadedRef).id === "string" &&
    typeof (value as UploadedRef).url === "string"
  );
}

async function uploadOne(clientId: string, file: File, note: string): Promise<UploadedRef> {
  const body = new FormData();
  body.append("file", file);
  body.append("note", note);
  const response = await fetch(`/api/clients/${clientId}/context`, { method: "POST", body });
  const payload = (await response.json().catch(() => ({}))) as Partial<UploadedRef> & { error?: string };
  if (!response.ok || !payload.id || !payload.url) {
    throw new Error(payload.error || `Upload failed for ${file.name}.`);
  }
  return { id: payload.id, url: payload.url, name: payload.name || file.name };
}

/**
 * Required-present check, in plain English. Returns null when the field is
 * valid. Exported (alongside the component) so the validation rules have unit
 * tests that don't depend on a render; the render itself is covered separately
 * in `dynamic-agent-intake-render.test.tsx`, which uses this repo's own
 * `renderToStaticMarkup` pattern.
 */
export function validateField(field: DynamicAgentInputDef, value: DynamicAgentInputValue): string | null {
  const isEmpty =
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
  if (field.required && isEmpty) return `${field.label || field.key} is required.`;
  return null;
}

/**
 * Does `fileName`/`mimeType` satisfy one `accept` token?
 *
 * Handles the three forms the HTML `accept` attribute allows, which is what an
 * admin types into the Studio: an extension (`.pdf`), a wildcard type
 * (`image/*`), and an exact MIME type (`application/pdf`). Comparison is
 * case-insensitive, because a browser reports `IMG_1.PNG` verbatim and an
 * admin writes `.png`.
 */
function matchesAcceptToken(token: string, fileName: string, mimeType: string): boolean {
  const rule = token.trim().toLowerCase();
  if (!rule) return false;
  const name = fileName.toLowerCase();
  const mime = mimeType.toLowerCase();
  if (rule.startsWith(".")) return name.endsWith(rule);
  if (rule.endsWith("/*")) return mime.startsWith(`${rule.slice(0, -1)}`);
  return mime === rule;
}

/**
 * File-TYPE validation against the field's `accept` list. Returns null when the
 * file is allowed (including when the admin set no `accept` at all, which means
 * "anything").
 *
 * This runs in JS rather than relying on the `accept` attribute alone: that
 * attribute only filters the OS picker's default view, and every browser lets
 * the person switch it to "All files" and pick anything — so treating the
 * attribute as validation would let a .exe through a field that asked for an
 * image. The attribute is still set on the input, for the good default it
 * gives; this is the part that actually blocks.
 */
export function validateFileType(field: DynamicAgentInputDef, file: { name: string; type: string }): string | null {
  const accept = field.accept?.trim();
  if (!accept) return null;
  const tokens = accept.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.some((token) => matchesAcceptToken(token, file.name, file.type))) return null;
  return `"${file.name}" is not an accepted file type for ${field.label || field.key}. Accepted: ${tokens.join(", ")}.`;
}

/** File-SIZE validation against the field's `maxSizeMb` (or the shared default). */
export function validateFileSize(
  field: DynamicAgentInputDef,
  file: { name: string; size: number },
): string | null {
  const limitMb = field.maxSizeMb ?? DEFAULT_MAX_SIZE_MB;
  if (file.size <= limitMb * 1024 * 1024) return null;
  return `"${file.name}" is larger than ${limitMb} MB.`;
}

export function DynamicAgentIntakeForm({
  inputSchema,
  clientId,
  submitLabel = "Run agent",
  submitting = false,
  onSubmit,
  creditsCost,
  priceIsEstimate = false,
  viewerIsBilled = true,
}: {
  inputSchema: DynamicAgentInputDef[];
  clientId: string;
  submitLabel?: string;
  submitting?: boolean;
  onSubmit: (values: Record<string, DynamicAgentInputValue>) => void;
  /**
   * `DynamicAgentSpec.creditsCost` — quoted above the submit (flow audit
   * 2026-09, R3). The press charges it immediately, with no confirm step, and
   * this surface quoted nothing at all. Absent ⇒ no line, for the admin-side
   * preview mounts that are not spending a client's credits.
   */
  creditsCost?: number;
  /**
   * Whether that figure is a HOLD that settles to what the run actually used
   * (`CREDITS_PLAN_V2_ENABLED`, threaded from the server — see DynamicAgentRun).
   * Wording only; the number is the same either way.
   */
  priceIsEstimate?: boolean;
  /** `isBillableClientActor()` — decides whose money the quote names, not the figure. */
  viewerIsBilled?: boolean;
}) {
  const formId = useId();
  const fields = [...inputSchema].sort((a, b) => a.order - b.order);
  const [values, setValues] = useState<Record<string, DynamicAgentInputValue>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function setValue(key: string, value: DynamicAgentInputValue) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: "" }));
  }

  async function handleFiles(field: DynamicAgentInputDef, files: FileList) {
    setFormError(null);
    const selected = Array.from(files);
    // Type first, then size: telling someone their .exe is too big would be
    // the wrong sentence even when it is also true.
    const rejection =
      selected.map((f) => validateFileType(field, f)).find((m): m is string => m !== null) ??
      selected.map((f) => validateFileSize(field, f)).find((m): m is string => m !== null);
    if (rejection) {
      setFieldErrors((current) => ({ ...current, [field.key]: rejection }));
      return;
    }
    setUploading((current) => ({ ...current, [field.key]: true }));
    try {
      const uploaded = await Promise.all(selected.map((f) => uploadOne(clientId, f, `Input: ${field.label}`)));
      setValue(field.key, uploaded.length === 1 ? uploaded[0] : uploaded);
    } catch (err) {
      setFieldErrors((current) => ({
        ...current,
        [field.key]: err instanceof Error ? err.message : "Upload failed.",
      }));
    } finally {
      setUploading((current) => ({ ...current, [field.key]: false }));
    }
  }

  function validateAll(): boolean {
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      const error = validateField(field, values[field.key] ?? null);
      if (error) nextErrors[field.key] = error;
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setFormError("Fix the highlighted fields before running this agent.");
      return false;
    }
    setFormError(null);
    return true;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateAll()) return;
    // Every declared field gets a key in the payload, even when the client
    // left an optional one blank — a step-runner reading `inputs.<key>` for an
    // unanswered optional field sees `null`, never a missing property.
    const payload: Record<string, DynamicAgentInputValue> = {};
    for (const field of fields) payload[field.key] = values[field.key] ?? null;
    onSubmit(payload);
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit} noValidate>
      {fields.length === 0 ? (
        <p className="text-xs text-muted-2">This agent has no additional questions, just run it.</p>
      ) : (
        fields.map((field) => {
          const fieldId = `${formId}-${field.key}`;
          const error = fieldErrors[field.key];
          return (
            <div key={field.key}>
              <Label htmlFor={fieldId}>
                {field.label}
                {field.required ? <span className="ml-1 text-danger">*</span> : null}
              </Label>
              {field.helpText ? <p className="mb-1.5 text-xs text-muted-2">{field.helpText}</p> : null}

              {field.type === "text" ? (
                <Input
                  id={fieldId}
                  value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
                  onChange={(e) => setValue(field.key, e.target.value)}
                  required={field.required}
                  {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                />
              ) : null}

              {field.type === "textarea" ? (
                <Textarea
                  id={fieldId}
                  value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
                  onChange={(e) => setValue(field.key, e.target.value)}
                  required={field.required}
                  {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                />
              ) : null}

              {field.type === "select" ? (
                <Select
                  id={fieldId}
                  value={typeof values[field.key] === "string" ? (values[field.key] as string) : ""}
                  onChange={(e) => setValue(field.key, e.target.value)}
                  required={field.required}
                >
                  <option value="">Select…</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              ) : null}

              {field.type === "file" || field.type === "image" ? (
                <div>
                  <input
                    id={fieldId}
                    type="file"
                    accept={field.accept}
                    multiple={field.type === "file"}
                    onChange={(e) => {
                      if (e.target.files?.length) void handleFiles(field, e.target.files);
                    }}
                    className="block w-full text-xs text-muted-2"
                  />
                  {uploading[field.key] ? (
                    <p className="mt-1 text-xs text-muted-2" aria-live="polite">
                      Uploading…
                    </p>
                  ) : null}
                  {(() => {
                    const value = values[field.key];
                    const refs = Array.isArray(value) ? value.filter(isUploadedRef) : isUploadedRef(value) ? [value] : [];
                    return refs.length > 0 ? (
                      <ul className="mt-1 space-y-0.5">
                        {refs.map((ref) => (
                          <li key={ref.id} className="flex items-center gap-1.5 text-xs text-muted">
                            <Icon name="Paperclip" className="h-3 w-3" />
                            {ref.name}
                          </li>
                        ))}
                      </ul>
                    ) : null;
                  })()}
                </div>
              ) : null}

              {error ? (
                <p className="mt-1 text-xs text-danger" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          );
        })
      )}

      {formError ? (
        <p className="text-xs text-danger" role="alert">
          {formError}
        </p>
      ) : null}

      <CreditPriceNote
        price={
          creditsCost == null
            ? null
            : // The hedge lives in the STRING, which is CreditPriceNote's own
              // rule — see its note on why: most of its callers quote an
              // unsettled setup charge, and this one does not.
              priceIsEstimate
              ? estimatedCreditsLabel(creditsCost)
              : creditsLabel(creditsCost)
        }
        viewerIsBilled={viewerIsBilled}
        className="mt-0"
      />
      <Button type="submit" disabled={submitting} loading={submitting}>
        {submitLabel}
      </Button>
    </form>
  );
}
