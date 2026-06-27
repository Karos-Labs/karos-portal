"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard SSR hydration guard
  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="h-9 w-9 shrink-0" />;

  // resolvedTheme may be undefined if next-themes context is not yet settled;
  // fall back to reading the HTML class directly so the toggle is always reliable.
  const isDark =
    resolvedTheme !== undefined
      ? resolvedTheme !== "light"
      : !document.documentElement.classList.contains("light");

  function toggle() {
    const next = isDark ? "light" : "dark";
    // Sync next-themes state (persists to localStorage and updates resolvedTheme)
    setTheme(next);
    // Direct DOM write as an immediate fallback — no-op if setTheme already did it
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(next);
  }

  return (
    <button
      onClick={toggle}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-muted",
        "transition-all duration-150 hover:bg-surface-2 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/40",
      )}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <Icon name={isDark ? "Sun" : "Moon"} className="h-4 w-4" />
    </button>
  );
}
