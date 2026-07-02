"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/** A labeled light/dark toggle that clearly shows the current mode. */
export function ThemeSwitch() {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard SSR hydration guard
  useEffect(() => setMounted(true), []);

  const isDark = mounted
    ? resolvedTheme !== "light"
    : true;

  function toggle() {
    const next = isDark ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(next);
  }

  return (
    <button
      onClick={toggle}
      className="flex w-full items-center justify-between rounded-md px-3 py-2 text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
    >
      <span className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.14em]">
        <Icon name={isDark ? "Moon" : "Sun"} className="h-4 w-4 text-muted-2" />
        {isDark ? "Dark mode" : "Light mode"}
      </span>
      <span
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          isDark ? "bg-surface-3" : "bg-success",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-primary shadow transition-transform duration-200",
            isDark ? "translate-x-0.5" : "translate-x-[18px]",
          )}
        />
      </span>
    </button>
  );
}
