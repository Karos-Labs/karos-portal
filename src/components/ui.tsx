import * as React from "react";
import { cn } from "@/lib/utils";

/* -------------------------------- Button -------------------------------- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "outline" | "danger" | "subtle";
  size?: "sm" | "md" | "lg" | "icon";
  loading?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", loading, children, disabled, ...props }, ref) => {
    const variants: Record<string, string> = {
      primary:
        "bg-neon text-[#03110b] font-semibold hover:bg-neon-bright shadow-[0_0_22px_-6px_var(--neon-glow)] hover:shadow-[0_0_30px_-4px_var(--neon-glow)]",
      ghost: "text-foreground hover:bg-surface-2",
      outline: "border border-border-strong text-foreground hover:border-neon-dim hover:text-neon",
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
          "inline-flex items-center justify-center rounded-[10px] transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/40 cursor-pointer",
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
        "card-grad rounded-[var(--radius)] border border-border p-5 transition-all duration-200 hover:border-border-strong shadow-[0_1px_6px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.03)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-base font-semibold text-foreground", className)} {...props} />;
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
        "w-full h-10 rounded-[10px] bg-surface-2 border border-border px-3 text-sm text-foreground placeholder:text-muted-2 outline-none transition-colors focus:border-neon-dim focus:ring-2 focus:ring-neon/20",
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
        "w-full min-h-[96px] rounded-[10px] bg-surface-2 border border-border px-3 py-2.5 text-sm text-foreground placeholder:text-muted-2 outline-none transition-colors focus:border-neon-dim focus:ring-2 focus:ring-neon/20 resize-y",
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
        "w-full h-10 rounded-[10px] bg-surface-2 border border-border px-3 text-sm text-foreground outline-none transition-colors focus:border-neon-dim focus:ring-2 focus:ring-neon/20 cursor-pointer",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = "Select";

/* -------------------------------- Badge --------------------------------- */

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "neon" | "warning" | "danger" | "info";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-3 text-muted border-border",
    neon:    "bg-neon-soft text-neon border-neon/30 shadow-[0_0_10px_-3px_rgba(45,255,158,0.35)]",
    warning: "bg-warning/10 text-warning border-warning/30",
    danger:  "bg-danger/10 text-danger border-danger/30",
    info:    "bg-info/10 text-info border-info/30",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
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
      className={cn("animate-shimmer rounded-[8px]", className)}
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

/* ------------------------------- StatCard ------------------------------- */

export function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <Card className="flex items-start justify-between">
      <div>
        <p className="text-xs text-muted">{label}</p>
        <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-2">{hint}</p>}
      </div>
      {icon && (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-neon-soft text-neon shadow-[0_0_14px_-4px_rgba(45,255,158,0.4)]">
          {icon}
        </div>
      )}
    </Card>
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
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
