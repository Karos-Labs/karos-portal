"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { ContactUsButton } from "@/components/contact-us-modal";

/**
 * What a client sees instead of a bare 404 when they open an intake page for an
 * agent they do not have (flow audit 2026-09, R9/F17 · NN/g *Empty States*).
 *
 * WHY IT IS A `not-found.tsx` AND NOT A CHANGED RETURN VALUE.
 * `requireIntakeAgentAccess` (lib/agent-intake-views.ts) calls `notFound()` and
 * returns the agent id — the refusal and the header control's destination are
 * deliberately one call, so a seventh intake page cannot render the control
 * without passing the gate (#82/#114). Turning the refusal into a value would
 * mean every one of the six pages remembering to render this, which is exactly
 * the shape that produced the gap. A route-segment `not-found.tsx` gets the
 * page-level state with the gate left exactly as it is: `notFound()` still
 * throws, Next still renders the nearest boundary, and that boundary is now
 * this instead of the workspace-wide "We couldn't find that page".
 *
 * WHAT IT MAY AND MAY NOT CLAIM. The only realistic way a CLIENT_USER reaches
 * it is the grant rung: the pages redirect a client whose `clientId` is not the
 * one in the URL before `requireVisibleClient` can 404 them, so for a client
 * "not found on this route" and "not on your plan" are the same event. It still
 * does not assert the agent EXISTS — the gate gives "not granted" and "does not
 * exist" one answer on purpose, so a client probing ids learns nothing about
 * the lab's catalogue.
 *
 * IT IS NOT WRITTEN AT A CLIENT ANY MORE (review wave, 2026-09). It said "This
 * agent isn't on your plan" and "Ask your Karos team if you want this one
 * added", and STAFF reach this boundary too: `requireIntakeAgentAccess` skips
 * its refusal for them, but a mistyped route, a client id they cannot see and
 * any other `notFound()` under these segments all land here — telling a Karos
 * admin about their plan, and to ask themselves for an agent. The sentence now
 * states the fact both readers share (this workspace does not have that agent
 * here) and points at the one page that lists what it does have.
 *
 * NOT BRANCHED ON ROLE, deliberately: a `not-found.tsx` boundary is handed no
 * params and no session, and the only way to give it one is a `requireUser()`
 * read inside an error page — a cookie read, a Firebase round trip and a
 * redirect path, on the page whose whole job is to render when something has
 * already gone wrong. One true sentence is cheaper and cannot go wrong.
 *
 * The roster link is read off the PATHNAME because a `not-found.tsx` boundary
 * is handed no `params` — there is no other way to know whose workspace the
 * refused URL was in. A path that does not match falls back to the workspace
 * root rather than guessing an id into a link.
 */
export function AgentNotOnPlan() {
  const pathname = usePathname();
  const clientId = /^\/clients\/([^/]+)/.exec(pathname ?? "")?.[1];
  const agentsHref = clientId ? `/clients/${clientId}/agents` : "/dashboard";

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted-2">
        <Icon name="Bot" className="h-6 w-6" />
      </div>
      <p className="text-lg font-medium text-foreground">This agent isn&apos;t available here</p>
      <p className="mt-2 max-w-sm text-sm text-muted">
        There&apos;s nothing to set up on this page. The agents this workspace has are on the AI
        agents page. If one is missing, the Karos team can add it.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Link
          href={agentsHref}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:border-neon/50 hover:text-neon"
        >
          {/* Names the destination rather than the reader: "See your agents" is
              a sentence about a plan, and half the people who land here are
              staff looking at somebody else's workspace. */}
          Go to AI agents
          <Icon name="ChevronRight" className="h-3.5 w-3.5" />
        </Link>
        {/* R7's one word for this dialog. No identity props: a not-found
            boundary has no session read of its own, and the server action the
            dialog posts to takes the sender from the session anyway. */}
        <ContactUsButton variant="row" />
      </div>
    </div>
  );
}
