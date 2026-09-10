import type { Tone } from "./presenter";

/**
 * Tone → CSS custom property, shared by the server panel and the client
 * gap list. Lives in its own dependency-free module so the "use client"
 * side can value-import it without pulling the domain lib into the bundle.
 */
export const TONE_COLORS: Record<Tone, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  info: "var(--info)",
  neutral: "var(--muted-2)",
};
