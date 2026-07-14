"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { Button, Label, Textarea } from "@/components/ui";
import { Icon } from "@/components/icon";
import { importReportAction, uploadReportPdfAction } from "@/lib/actions";

interface Props {
  open: boolean;
  onClose: () => void;
  clientId: string;
}

export function ImportReportModal({ open, onClose, clientId }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [markdown, setMarkdown] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f && f.type !== "application/pdf") {
      setError("Only PDF files are accepted.");
      return;
    }
    setPdfFile(f);
    setError(null);
  }

  async function submit() {
    if (!markdown.trim()) {
      setError("Paste the Markdown report content first.");
      return;
    }
    setError(null);
    setLoading(true);

    try {
      let pdfUrl: string | undefined;

      if (pdfFile) {
        setUploadProgress("Uploading PDF…");
        const buffer = await pdfFile.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        pdfUrl = await uploadReportPdfAction(clientId, bytes);
        setUploadProgress(null);
      }

      setUploadProgress("Parsing & saving report…");
      await importReportAction(clientId, markdown.trim(), pdfUrl);
      setUploadProgress(null);

      setMarkdown("");
      setPdfFile(null);
      if (fileRef.current) fileRef.current.value = "";
      onClose();
      router.refresh();
    } catch (e) {
      setUploadProgress(null);
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import Intelligence Report"
      description="Paste the full Markdown (.md) content of the Karos Intel report. Optionally attach the PDF file for direct export."
      className="max-w-2xl"
    >
      <div className="space-y-4">
        <div>
          <Label>Report Markdown *</Label>
          <Textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder={"# Karos Intel: Company Name\n**Digital Intelligence & Competitive Report**\n..."}
            className="h-56 font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-2">
            Copy the entire .md file content and paste it here.
          </p>
        </div>

        {/* PDF file upload */}
        <div>
          <Label>PDF Report (optional)</Label>
          <div
            className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-border p-3 transition-colors hover:border-neon/40 hover:bg-neon-soft"
            onClick={() => fileRef.current?.click()}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-3">
              <Icon name="FileText" className="h-4 w-4 text-muted-2" />
            </div>
            <div className="min-w-0 flex-1">
              {pdfFile ? (
                <>
                  <p className="truncate text-sm font-medium text-foreground">{pdfFile.name}</p>
                  <p className="text-xs text-muted-2">{(pdfFile.size / 1024).toFixed(0)} KB</p>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-2">Click to upload PDF</p>
                  <p className="text-xs text-muted-2">Saved to Storage: enables the Export PDF button</p>
                </>
              )}
            </div>
            {pdfFile && (
              <button
                type="button"
                className="shrink-0 text-muted-2 hover:text-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  setPdfFile(null);
                  if (fileRef.current) fileRef.current.value = "";
                }}
                aria-label="Remove file"
              >
                <Icon name="X" className="h-4 w-4" />
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={pickFile}
            className="hidden"
          />
        </div>

        {uploadProgress && (
          <div className="flex items-center gap-2 rounded-md border border-neon/20 bg-neon-soft px-3 py-2">
            <Icon name="Loader" className="h-4 w-4 animate-spin text-neon" />
            <p className="text-xs text-neon">{uploadProgress}</p>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
            <Icon name="TriangleAlert" className="h-4 w-4 shrink-0 text-danger" />
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" loading={loading} onClick={submit}>
            <Icon name="Upload" className="h-4 w-4" />
            {loading ? uploadProgress ?? "Processing…" : "Import report"}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
