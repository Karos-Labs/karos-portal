"use client";

import { useMemo, useState } from "react";
import { TabButton } from "@/components/ui";
import { Icon } from "@/components/icon";

/**
 * The newsletter edition as a subscriber will see it.
 *
 * agent-engine's newsletter workflow renders every approved edition to
 * email-safe HTML (600px table layout, inline styles, no scripts) in a light
 * and a dark theme, and the materializer carries both in `asset.meta.html` /
 * `asset.meta.htmlDark` (2026-09-05). Until this component existed the only
 * thing a customer could see was the markdown text, and the only thing they
 * could copy was that text: a newsletter product whose deliverable was not
 * yet an email.
 *
 * The render is shown in a sandboxed `srcDoc` iframe: no scripts, no same-
 * origin access, so a document that came out of a model run can be displayed
 * without becoming part of this page. "Copy HTML" hands over the exact
 * document, which is what an email platform's "paste your HTML" box wants.
 */
export function EmailPreview({
  html,
  htmlDark,
  textFallback,
}: {
  html: string;
  htmlDark?: string;
  /** The markdown/text view the modal already had, shown under the "Text" tab. */
  textFallback: React.ReactNode;
}) {
  const [view, setView] = useState<"email" | "text">("email");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  const active = theme === "dark" && htmlDark ? htmlDark : html;
  const sizeKb = useMemo(() => Math.round(new Blob([active]).size / 1024), [active]);

  async function copyHtml() {
    const ok = await writeToClipboard(active);
    setCopied(ok ? "copied" : "failed");
    setTimeout(() => setCopied("idle"), ok ? 1500 : 2500);
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border">
        <div className="flex items-center">
          <TabButton active={view === "email"} onClick={() => setView("email")} icon="Mail">
            Email
          </TabButton>
          <TabButton active={view === "text"} onClick={() => setView("text")} icon="FileText">
            Text
          </TabButton>
        </div>
        {view === "email" && (
          <div className="flex items-center gap-1 pb-1">
            {htmlDark && (
              <button
                type="button"
                onClick={() => setTheme(theme === "light" ? "dark" : "light")}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-foreground"
                aria-label={theme === "light" ? "Show the dark theme" : "Show the light theme"}
              >
                <Icon name={theme === "light" ? "Moon" : "Sun"} className="h-3.5 w-3.5" />
                {theme === "light" ? "Dark" : "Light"}
              </button>
            )}
            <button
              type="button"
              onClick={copyHtml}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-foreground"
            >
              <Icon name={copied === "copied" ? "Check" : copied === "failed" ? "TriangleAlert" : "Copy"} className="h-3.5 w-3.5" />
              {copied === "copied" ? "Copied" : copied === "failed" ? "Press and hold to copy" : "Copy HTML"}
            </button>
          </div>
        )}
      </div>

      {view === "email" ? (
        <div>
          <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
            <iframe
              title="Email preview"
              // No scripts, no same-origin: the document is displayed, never trusted.
              sandbox=""
              srcDoc={active}
              className="block h-[720px] w-full bg-transparent"
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-2">
            Rendered exactly as it will be sent, 600px wide. {sizeKb} KB
            {sizeKb > 100 ? " (Gmail clips messages over 102 KB; trim before sending)" : ""}.
          </p>
        </div>
      ) : (
        textFallback
      )}
    </div>
  );
}

/** Same two-path copy as copy-caption-button.tsx: the async Clipboard API where it exists, the legacy selection path where it does not. */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
