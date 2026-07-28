"use client";

/**
 * A setup section that is already filled in: the gist at a glance plus an edit
 * affordance, with the caller's form taking over while `open`. The caller owns
 * the open state because only it can restore its field values when the user
 * backs out. Anything passed as `notice` or `footer` renders in both states —
 * warnings must not hide behind the collapse, and ongoing inputs are not setup.
 */

import type { ReactNode } from "react";
import { Button, Card, CardTitle } from "@/components/ui";
import { Icon } from "@/components/icon";

export interface SavedFormLine {
  label: string;
  /** Empty reads as "None yet", dimmed — callers pass the raw field value. */
  value: string;
}

export function SavedFormCard({
  title,
  badge,
  notice,
  summary,
  open,
  onEdit,
  children,
  footer,
}: {
  title: string;
  badge?: ReactNode;
  notice?: ReactNode;
  summary: SavedFormLine[];
  open: boolean;
  onEdit: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>{title}</CardTitle>
        <div className="flex shrink-0 items-center gap-2">
          {badge}
          {open ? null : (
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Icon name="Pencil" className="h-3.5 w-3.5" />
              Edit
            </Button>
          )}
        </div>
      </div>
      {notice}
      {open ? (
        children
      ) : (
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {summary.map((line) => (
            <div key={line.label}>
              <dt className="text-xs text-muted">{line.label}</dt>
              <dd
                className={`mt-0.5 line-clamp-2 text-sm ${line.value ? "text-foreground" : "text-muted-2"}`}
              >
                {line.value || "None yet"}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {footer}
    </Card>
  );
}
