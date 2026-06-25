"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { archiveTranscriptAction, unarchiveTranscriptAction } from "@/lib/actions";

interface Props {
  transcriptId: string;
  archived: boolean;
}

export function ArchiveButton({ transcriptId, archived }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function toggle() {
    setLoading(true);
    try {
      if (archived) await unarchiveTranscriptAction(transcriptId);
      else await archiveTranscriptAction(transcriptId);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={toggle} loading={loading}>
      <Icon name={archived ? "ArchiveRestore" : "Archive"} className="h-4 w-4" />
      {archived ? "Unarchive" : "Archive"}
    </Button>
  );
}
