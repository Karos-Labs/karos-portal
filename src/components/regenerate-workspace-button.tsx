"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { RegenerateModal } from "@/components/client-documents";

/**
 * Admin-only Regenerate entry point for the staff client dashboard (CD-G5).
 *
 * The same control already lives in the documents header of the client rail, but
 * the pipeline it runs rebuilds far more than the documents — it also rewrites
 * the client's SEO/GEO intel — so it belongs at client level, not buried in a
 * sidebar section named after only one of its outputs. Same modal, same server
 * action, same AI-processing lock; only the entry point is new.
 */
export function RegenerateWorkspaceButton({
  clientId,
  isAiProcessing,
}: {
  clientId: string;
  /** True while a background AI generation cycle is running — locks the button, exactly as in the rail. */
  isAiProcessing?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={isAiProcessing}
        title={
          isAiProcessing
            ? "Karos Agents are already building this workspace. Please wait for it to finish"
            : "Re-run the Intel Report pipeline: rebuilds this client's documents and their SEO/GEO intel"
        }
      >
        <Icon name="RefreshCw" className="h-3.5 w-3.5" />
        Regenerate docs + SEO/GEO
      </Button>

      <RegenerateModal
        clientId={clientId}
        open={open}
        onClose={() => setOpen(false)}
        onSuccess={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}
