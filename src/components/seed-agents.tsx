"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { seedAgentsAction } from "@/lib/actions";

export function SeedAgentsButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function seed() {
    setLoading(true);
    try {
      await seedAgentsAction();
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={seed} loading={loading}>
      <Icon name="Sparkles" className="h-4 w-4" />
      Add starter agents
    </Button>
  );
}
