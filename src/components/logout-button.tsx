"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

export function LogoutButton({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handle() {
    setLoading(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
      await signOut(auth).catch(() => {});
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  if (compact) {
    return (
      <button
        onClick={handle}
        className={cn(
          "flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-danger",
        )}
      >
        <Icon name="LogOut" className="h-4 w-4" />
        {loading ? "Signing out…" : "Sign out"}
      </button>
    );
  }

  return (
    <Button variant="outline" onClick={handle} loading={loading}>
      <Icon name="LogOut" className="h-4 w-4" />
      Sign out
    </Button>
  );
}
