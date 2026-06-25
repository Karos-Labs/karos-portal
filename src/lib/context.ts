import type { ContextItem } from "@/lib/types";

/** Plain text mime types we inline directly into the prompt. */
const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/** Classify an uploaded file by mime type — drives how (and whether) agents consume it. */
export function contextKind(mimeType: string): ContextItem["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "document";
  if (TEXT_MIMES.has(mimeType) || mimeType.startsWith("text/")) return "text";
  return "other";
}

/** Caps that bound token cost when injecting client context into a run. */
export const CONTEXT_CAPS = {
  images: 6,
  documents: 3,
  textChars: 6000,
} as const;
