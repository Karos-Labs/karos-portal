"use client";

import { useState } from "react";
import { Button, Input, Label, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { DynamicAgentInputDef, DynamicAgentInputType } from "@/lib/types";

const INPUT_TYPES: { value: DynamicAgentInputType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Textarea" },
  { value: "file", label: "File" },
  { value: "image", label: "Image" },
  { value: "select", label: "Select" },
];

function blankField(order: number): DynamicAgentInputDef {
  return {
    key: "",
    type: "text",
    label: "",
    helpText: "",
    required: false,
    order,
  };
}

const KEY_HELP = "Lowercase letters, digits, and underscores only, starting with a letter — this becomes the context variable name AI prompts and code steps read the client's answer under.";

/**
 * Agent Studio's Input Schema Builder (Phase 3): add / delete / reorder
 * client intake fields, per-field type/required/help text, and a
 * select-options editor shown only for `type === "select"`. Reordering keeps
 * `order` dense and 0-indexed locally; the server re-normalizes it again on
 * save (dynamic-agent-actions.ts) so the two can never drift.
 */
export function InputSchemaBuilder({
  initial,
  pending,
  error,
  onSave,
}: {
  initial: DynamicAgentInputDef[];
  pending: boolean;
  error: string | null;
  onSave: (fields: DynamicAgentInputDef[]) => void;
}) {
  const [fields, setFields] = useState<DynamicAgentInputDef[]>(
    [...initial].sort((a, b) => a.order - b.order),
  );

  function update(index: number, patch: Partial<DynamicAgentInputDef>) {
    setFields((current) => current.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function addField() {
    setFields((current) => [...current, blankField(current.length)]);
  }

  function removeField(index: number) {
    setFields((current) => current.filter((_, i) => i !== index).map((f, i) => ({ ...f, order: i })));
  }

  function move(index: number, direction: -1 | 1) {
    setFields((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((f, i) => ({ ...f, order: i }));
    });
  }

  return (
    <div className="space-y-4">
      {fields.length === 0 ? (
        <p className="text-xs text-muted-2">No input fields yet. The client intake form will be empty.</p>
      ) : (
        <div className="space-y-3">
          {fields.map((field, index) => {
            // htmlFor/id pairing only needs to be unique within this render, and the
            // list is already keyed by `index` below — no need for a field that has
            // no key yet to mint its own id from a module-level counter.
            const key = field.key || `field-${index}`;
            return (
              <div key={index} className="rounded-md border border-border bg-surface-2 p-3">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
                    Field {index + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      aria-label="Move up"
                    >
                      <Icon name="ChevronUp" className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={index === fields.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label="Move down"
                    >
                      <Icon name="ChevronDown" className="h-4 w-4" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" onClick={() => removeField(index)} aria-label="Delete field">
                      <Icon name="Trash2" className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor={`ib-key-${key}`}>Key</Label>
                    <Input
                      id={`ib-key-${key}`}
                      value={field.key}
                      onChange={(e) => update(index, { key: e.target.value.trim() })}
                      placeholder="e.g. company_name"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`ib-type-${key}`}>Type</Label>
                    <Select
                      id={`ib-type-${key}`}
                      value={field.type}
                      onChange={(e) => {
                        const type = e.target.value as DynamicAgentInputType;
                        update(index, {
                          type,
                          options: type === "select" ? field.options ?? [""] : undefined,
                          accept: type === "file" || type === "image" ? field.accept : undefined,
                          maxSizeMb: type === "file" || type === "image" ? field.maxSizeMb : undefined,
                        });
                      }}
                    >
                      {INPUT_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-2">{KEY_HELP}</p>

                <div className="mt-3">
                  <Label htmlFor={`ib-label-${key}`}>Label</Label>
                  <Input
                    id={`ib-label-${key}`}
                    value={field.label}
                    onChange={(e) => update(index, { label: e.target.value })}
                    placeholder="What the client sees above this field"
                  />
                </div>

                <div className="mt-3">
                  <Label htmlFor={`ib-help-${key}`}>Help text (optional)</Label>
                  <Textarea
                    id={`ib-help-${key}`}
                    value={field.helpText ?? ""}
                    onChange={(e) => update(index, { helpText: e.target.value })}
                    className="min-h-[60px]"
                  />
                </div>

                {/* Placeholder only for the two types that HAVE one: a select
                    shows its own "Select…" option and a file input's chrome is
                    the browser's. Saving one on any other type is refused by
                    validateAndNormalizeInputSchema rather than silently dropped,
                    so the field is simply not offered here. */}
                {(field.type === "text" || field.type === "textarea") && (
                  <div className="mt-3">
                    <Label htmlFor={`ib-placeholder-${key}`}>Placeholder (optional)</Label>
                    <p className="mb-1.5 text-[11px] leading-snug text-muted-2">
                      Ghost text inside the box. It disappears as soon as the client types, so use it for an
                      example, not for an instruction they will still need.
                    </p>
                    <Input
                      id={`ib-placeholder-${key}`}
                      value={field.placeholder ?? ""}
                      onChange={(e) => update(index, { placeholder: e.target.value })}
                      placeholder="e.g. Acme Industries"
                      maxLength={120}
                    />
                  </div>
                )}

                <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="accent-neon"
                    checked={field.required}
                    onChange={(e) => update(index, { required: e.target.checked })}
                  />
                  Required
                </label>

                {field.type === "select" ? (
                  <div className="mt-3">
                    <Label>Options</Label>
                    <div className="space-y-1.5">
                      {(field.options ?? []).map((option, optIndex) => (
                        <div key={optIndex} className="flex items-center gap-1.5">
                          <Input
                            value={option}
                            onChange={(e) => {
                              const options = [...(field.options ?? [])];
                              options[optIndex] = e.target.value;
                              update(index, { options });
                            }}
                          />
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() =>
                              update(index, {
                                options: (field.options ?? []).filter((_, i) => i !== optIndex),
                              })
                            }
                            aria-label="Remove option"
                          >
                            <Icon name="X" className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-1.5"
                      onClick={() => update(index, { options: [...(field.options ?? []), ""] })}
                    >
                      <Icon name="Plus" className="h-3.5 w-3.5" />
                      Add option
                    </Button>
                  </div>
                ) : null}

                {field.type === "file" || field.type === "image" ? (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor={`ib-accept-${key}`}>Accepted files</Label>
                      <Input
                        id={`ib-accept-${key}`}
                        value={field.accept ?? ""}
                        onChange={(e) => update(index, { accept: e.target.value })}
                        placeholder="image/png,image/jpeg"
                      />
                    </div>
                    <div>
                      <Label htmlFor={`ib-maxsize-${key}`}>Max size (MB)</Label>
                      <Input
                        id={`ib-maxsize-${key}`}
                        type="number"
                        min={1}
                        value={field.maxSizeMb ?? ""}
                        onChange={(e) =>
                          update(index, { maxSizeMb: e.target.value ? Number(e.target.value) : undefined })
                        }
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <Button type="button" variant="outline" onClick={addField}>
        <Icon name="Plus" className="h-3.5 w-3.5" />
        Add field
      </Button>

      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}

      <div>
        <Button type="button" disabled={pending} loading={pending} onClick={() => onSave(fields)}>
          Save input schema
        </Button>
      </div>
    </div>
  );
}
