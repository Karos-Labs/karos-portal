"use client";

import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { Client } from "@/lib/types";

/* ── Color helpers ────────────────────────────────────────────────── */

function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return null;
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lighten(hex: string, amt: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((c) => Math.min(255, Math.round(c + (255 - c) * amt)));
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

function darken(hex: string, amt: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((c) => Math.max(0, Math.round(c * (1 - amt))));
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

function blend(base: string, overlay: string, t: number): string {
  const b = hexToRgb(base);
  const o = hexToRgb(overlay);
  if (!b || !o) return base;
  const [r, g, ch] = b.map((c, i) => Math.round(c + (o[i] - c) * t));
  return "#" + [r, g, ch].map((c) => (c ?? 0).toString(16).padStart(2, "0")).join("");
}

// Separate background defaults for each theme so the brand tint is always
// layered on top of the correct surface colour, not forced dark in light mode.
const DARK_DEFAULTS = { bg: "#07090b", surface: "#0d1117", surface2: "#131a22" };
const LIGHT_DEFAULTS = { bg: "#f8fafc", surface: "#ffffff", surface2: "#f1f5f9" };

const ACCENT_VARS = ["--neon", "--neon-bright", "--neon-dim", "--neon-glow", "--neon-soft"] as const;
const BG_VARS = ["--background", "--surface", "--surface-2"] as const;

function useBrandPreview(guidelines: Client["brandingGuidelines"], active: boolean) {
  // resolvedTheme is the settled "dark" | "light" value from next-themes.
  // Including it in the dependency array means the effect re-runs whenever the
  // user flips the global theme toggle while the preview is open, so the brand
  // tint always layers on the correct surface.
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const root = document.documentElement;

    if (!active || !guidelines) {
      [...ACCENT_VARS, ...BG_VARS].forEach((v) => root.style.removeProperty(v));
      root.style.removeProperty("--font-sans");
      return;
    }

    const isLight = resolvedTheme === "light";
    const defaults = isLight ? LIGHT_DEFAULTS : DARK_DEFAULTS;

    // ── Accent / neon colour system ─────────────────────────────────
    const accent = guidelines.secondaryColor || guidelines.primaryColor;
    if (accent) {
      const rgb = hexToRgb(accent);
      const rgbStr = rgb ? rgb.join(", ") : null;

      // In light mode the accent must be dark enough to clear WCAG AA against
      // white surfaces; darken slightly so thin text stays legible.
      const neonBase = isLight ? darken(accent, 0.12) : accent;

      root.style.setProperty("--neon", neonBase);
      root.style.setProperty("--neon-bright", isLight ? accent : lighten(accent, 0.15));
      root.style.setProperty("--neon-dim", darken(accent, 0.22));
      // Glow is more subdued in light mode so it doesn't bleed on white cards.
      const glowAlpha = isLight ? 0.18 : 0.35;
      const softAlpha = isLight ? 0.06 : 0.12;
      root.style.setProperty("--neon-glow", rgbStr ? `rgba(${rgbStr}, ${glowAlpha})` : `${accent}${isLight ? "2e" : "59"}`);
      root.style.setProperty("--neon-soft", rgbStr ? `rgba(${rgbStr}, ${softAlpha})` : `${accent}${isLight ? "0f" : "1f"}`);
    }

    // ── Background tint ─────────────────────────────────────────────
    // Use a lighter blend in light mode so the tint is a gentle wash rather
    // than a colour shift that kills foreground contrast.
    const primary = guidelines.primaryColor;
    if (primary) {
      const bgAmt = isLight ? 0.06 : 0.15;
      const srfAmt = isLight ? 0.04 : 0.12;
      const sr2Amt = isLight ? 0.03 : 0.10;
      root.style.setProperty("--background", blend(defaults.bg, primary, bgAmt));
      root.style.setProperty("--surface", blend(defaults.surface, primary, srfAmt));
      root.style.setProperty("--surface-2", blend(defaults.surface2, primary, sr2Amt));
    }

    // ── Brand font ──────────────────────────────────────────────────
    const font = guidelines.fontHeading || guidelines.fontBody;
    if (font) {
      const systemFonts = new Set([
        "Inter", "Arial", "Helvetica", "Georgia", "Verdana",
        "Times New Roman", "Open Sans", "Montserrat",
      ]);
      if (!systemFonts.has(font)) {
        const id = "brand-preview-font";
        if (!document.getElementById(id)) {
          const link = document.createElement("link");
          link.id = id;
          link.rel = "stylesheet";
          link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;600;700&display=swap`;
          document.head.appendChild(link);
        }
      }
      root.style.setProperty("--font-sans", `"${font}", ui-sans-serif, system-ui, sans-serif`);
    }

    return () => {
      [...ACCENT_VARS, ...BG_VARS].forEach((v) => root.style.removeProperty(v));
      root.style.removeProperty("--font-sans");
      document.getElementById("brand-preview-font")?.remove();
    };
  }, [active, guidelines, resolvedTheme]);
}

/* ── Component ───────────────────────────────────────────────────── */

export function PreviewBrandButton({
  guidelines,
}: {
  guidelines: Client["brandingGuidelines"];
}) {
  const [active, setActive] = useState(false);
  const canPreview = !!(guidelines?.primaryColor || guidelines?.fontHeading);

  useBrandPreview(guidelines, active);

  if (!canPreview) return null;

  return (
    <Button
      size="sm"
      variant={active ? "primary" : "outline"}
      onClick={() => setActive((v) => !v)}
      title={active ? "Revert to default theme" : "Preview this client's brand theme"}
    >
      <Icon name={active ? "EyeOff" : "Eye"} className="h-3.5 w-3.5" />
      {active ? "Exit preview" : "Preview brand"}
    </Button>
  );
}
