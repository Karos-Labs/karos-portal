import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icon";

/* -------------------------------- Button --------------------------------
   Ember voices (§7): primary = paper/ink (flips in light mode), accent = the
   one orange CTA (rationed), ghost/outline = hairline utilities. */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "outline" | "danger" | "subtle" | "accent";
  size?: "sm" | "md" | "lg" | "icon";
  loading?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", loading, children, disabled, ...props }, ref) => {
    const variants: Record<string, string> = {
      primary:
        "bg-primary text-primary-foreground font-semibold shadow-[0_8px_22px_-8px_color-mix(in_srgb,var(--primary)_55%,transparent)] hover:-translate-y-0.5",
      accent:
        "bg-neon text-accent-ink font-semibold hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-10px_color-mix(in_srgb,var(--neon)_55%,transparent)]",
      ghost: "text-muted hover:bg-surface-2 hover:text-foreground",
      outline:
        "border border-border text-foreground hover:border-foreground/30 hover:bg-foreground/[0.04]",
      subtle: "bg-surface-2 text-foreground hover:bg-surface-3 border border-border",
      danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
    };
    const sizes: Record<string, string> = {
      sm: "h-8 px-3 text-xs gap-1.5",
      md: "h-10 px-4 text-sm gap-2",
      lg: "h-12 px-6 text-base gap-2",
      icon: "h-10 w-10 justify-center",
    };
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center rounded-md transition-all duration-200 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25 cursor-pointer",
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      >
        {loading && <Spinner className="h-4 w-4" />}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

/* --------------------------------- Card --------------------------------- */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "card-grad rounded-[var(--radius)] border border-border p-5 transition-colors duration-200 hover:border-border-strong",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-lg text-foreground", className)} {...props} />;
}

/* -------------------------------- Inputs -------------------------------- */

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("block text-xs font-medium text-muted mb-1.5", className)}
      {...props}
    />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "w-full h-10 rounded-md bg-foreground/[0.04] border border-foreground/15 px-3 text-sm text-foreground placeholder:text-foreground/35 outline-none transition-colors focus:border-foreground/25",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full min-h-[96px] rounded-md bg-foreground/[0.04] border border-foreground/15 px-3 py-2.5 text-sm text-foreground placeholder:text-foreground/35 outline-none transition-colors focus:border-foreground/25 resize-y",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "w-full h-10 rounded-md bg-foreground/[0.04] border border-foreground/15 px-3 text-sm text-foreground outline-none transition-colors focus:border-foreground/25 cursor-pointer [&>option]:bg-surface",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = "Select";

/* -------------------------------- Badge ---------------------------------
   Squared chips (§8) - mono labels, hairline borders, no glow. */

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "neon" | "success" | "warning" | "danger" | "info";
  className?: string;
}) {
  /* Judgment scale: success green / warning amber / danger red / info slate.
     The historical "neon" tone means "good" - it renders success green so the
     brand orange never participates in status colors. */
  const tones: Record<string, string> = {
    neutral: "bg-surface-3 text-muted border-border",
    neon:    "bg-success/10 text-success border-success/30",
    success: "bg-success/10 text-success border-success/30",
    warning: "bg-warning/10 text-warning border-warning/30",
    danger:  "bg-danger/10 text-danger border-danger/30",
    info:    "bg-info/10 text-info border-info/30",
  };
  return (
    <span
      className={cn(
        /* `shrink-0 whitespace-nowrap` (2026-08): a badge is a two-word status
           chip, and as a flex sibling of a min-w-0 text block it was being
           chosen as the thing that gives — "AWAITING REVIEW" broke across two
           lines and overlapped the row beside it once the dashboard columns got
           narrow. The text block next to it already truncates; that is the
           element meant to absorb the pressure. */
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em]",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------- Spinner -------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full border-2 border-current border-t-transparent animate-spin-slow",
        className,
      )}
    />
  );
}

/* ------------------------------ Skeleton -------------------------------- */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-shimmer rounded-md", className)}
      aria-hidden="true"
    />
  );
}

/* ------------------------------ EmptyState ------------------------------ */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius)] border border-dashed border-border py-14 px-6 text-center">
      {icon && <div className="mb-3 text-muted-2">{icon}</div>}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ------------------------------- StatCard -------------------------------
   Minimal: mono label over a mono numeral. No icon chip - the `icon` prop is
   accepted for call-site compatibility but intentionally not rendered. */

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <p className="font-mono text-[10px] uppercase leading-snug tracking-[0.08em] text-muted [overflow-wrap:anywhere]">
        {label}
      </p>
      <p className="mt-1.5 font-mono text-2xl font-medium text-foreground">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-2">{hint}</p>}
    </Card>
  );
}

/* -------------------------------- TabButton ------------------------------
   Underline-style tab, lifted out of asset-detail-modal.tsx so a second tab
   strip (the Control Room) doesn't fork its own copy of the same pattern. */

export function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "border-neon text-foreground"
          : "border-transparent text-muted-2 hover:text-muted",
      )}
    >
      <Icon name={icon} className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

/* ------------------------------ PageHeader ------------------------------ */

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl text-foreground">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
