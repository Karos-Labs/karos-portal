"use client";

import { useState, useEffect } from "react";
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

const DEFAULT_BG = "#07090b";
const DEFAULT_SURFACE = "#0d1117";
const DEFAULT_SURFACE2 = "#131a22";

function blend(base: string, overlay: string, t: number): string {
  const b = hexToRgb(base);
  const o = hexToRgb(overlay);
  if (!b || !o) return base;
  const [r, g, ch] = b.map((c, i) => Math.round(c + (o[i] - c) * t));
  return "#" + [r, g, ch].map((c) => (c ?? 0).toString(16).padStart(2, "0")).join("");
}

const ACCENT_VARS = ["--neon", "--neon-bright", "--neon-dim", "--neon-glow", "--neon-soft"] as const;
const BG_VARS = ["--background", "--surface", "--surface-2"] as const;

function useBrandPreview(guidelines: Client["brandingGuidelines"], active: boolean) {
  useEffect(() => {
    const root = document.documentElement;

    if (!active || !guidelines) {
      [...ACCENT_VARS, ...BG_VARS].forEach((v) => root.style.removeProperty(v));
      root.style.removeProperty("--font-sans");
      return;
    }

    const accent = guidelines.secondaryColor || guidelines.primaryColor;
    if (accent) {
      const rgb = hexToRgb(accent);
      const rgbStr = rgb ? rgb.join(", ") : null;
      root.style.setProperty("--neon", accent);
      root.style.setProperty("--neon-bright", lighten(accent, 0.15));
      root.style.setProperty("--neon-dim", darken(accent, 0.2));
      root.style.setProperty("--neon-glow", rgbStr ? `rgba(${rgbStr}, 0.35)` : accent + "59");
      root.style.setProperty("--neon-soft", rgbStr ? `rgba(${rgbStr}, 0.12)` : accent + "1f");
    }

    const primary = guidelines.primaryColor;
    if (primary) {
      root.style.setProperty("--background", blend(DEFAULT_BG, primary, 0.15));
      root.style.setProperty("--surface", blend(DEFAULT_SURFACE, primary, 0.12));
      root.style.setProperty("--surface-2", blend(DEFAULT_SURFACE2, primary, 0.10));
    }

    const font = guidelines.fontHeading || guidelines.fontBody;
    if (font) {
      const systemFonts = new Set(["Inter", "Arial", "Helvetica", "Georgia", "Verdana", "Times New Roman", "Open Sans", "Montserrat"]);
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
  }, [active, guidelines]);
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
