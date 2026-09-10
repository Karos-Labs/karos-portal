"use client";

import { useActiveClient } from "@/lib/active-client-context";

/**
 * The staff workspace's `<main>`, and the one decision it exists to make: how
 * much scroll reserve to leave under the last row of a page.
 *
 * ── #127 ─────────────────────────────────────────────────────────────────────
 * The staff main was widened from the baseline `py-6 md:py-8` to a flat
 * `pb-28 md:pb-16 lg:pb-8` to clear the copilot strip sitting on top of the
 * bottom tab bar. BOTH of those render only in client-context mode:
 * `MobileTabBar` is mounted inside the `clientCtx ?` branch of sidebar.tsx, and
 * StaffCopilotDock returns null with no active client. Staff browsing the
 * agency workspace on a phone — the common case, since the context is opt-in
 * through the ClientContextPicker — got 112px of empty band under their content
 * with nothing standing in it, and 64px on a tablet.
 *
 * KEYED TO THE ARGUMENT, NOT TO A WIDTH. `activeClient` is the exact value both
 * pieces of chrome gate on, so the reserve cannot be present without them or
 * absent with them: the tab bar needs `isStaff && activeClient` and the dock
 * needs `activeClient`, and both of those are false whenever this is false.
 * (The converse is deliberately NOT claimed: with a context set the bar still
 * asks its own `isStaff`, so this can over-reserve where it can never
 * under-reserve — the direction that hides no content.)
 *
 * STAFF ONLY, and the name says so. The client shell's main keeps the flat
 * reserve and is right to: its bottom tab bar is unconditional. Mounting this
 * there would take a reserve away from chrome that is always on screen.
 */

/**
 * The staff main's classes for a given context state.
 *
 * Exported and pure so the rule is testable without a DOM: "no context, no
 * reserve" is a fact about the string, and the alternative — reading it back
 * out of the rendered markup — would test Tailwind rather than the decision.
 */
export function staffMainClass(hasClientContext: boolean): string {
  const base = "flex-1 overflow-x-clip px-4 pt-6 md:px-8 md:pt-8";
  // With a context: the copilot strip stacked on the 54px bar below md, the
  // strip alone from md up. Without: the pre-CD-G9a baseline, which is what the
  // page actually needs when nothing is pinned to the bottom of the viewport.
  return hasClientContext ? `${base} pb-28 md:pb-16 lg:pb-8` : `${base} pb-6 md:pb-8`;
}

export function StaffShellMain({ children }: { children: React.ReactNode }) {
  const { activeClient } = useActiveClient();
  return <main className={staffMainClass(activeClient !== null)}>{children}</main>;
}
