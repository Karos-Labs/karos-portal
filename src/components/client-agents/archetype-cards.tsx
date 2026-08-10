import Link from "next/link";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/icon";
import type { RedditIntakeView } from "@/components/reddit-agent-intake";

/**
 * The aside cards the two new archetypes replace "What it knows about you"
 * with (CD-I1).
 *
 * The generic card answers that question with one link, which is right for an
 * agent whose data is a form. It is wrong for both new shapes: a clip maker
 * runs on FILES the client has to hand over, and a daily finder runs on a list
 * of communities it is welcome in and a list it is banned from - and being
 * banned from a subreddit is the kind of fact a client wants to SEE on the
 * page, not behind a link.
 *
 * Server components: no state, nothing to hydrate, and everything they render
 * was already redacted at the RSC boundary.
 */

/* ─────────────────────────── clip maker: source ────────────────────────── */

/** One piece of footage on file, already stripped to what a browser may read. */
export interface SourceFile {
  id: string;
  name: string;
  /** Epoch millis. */
  at: number;
}

/**
 * What the clip maker cuts FROM.
 *
 * A clip maker cannot invent footage - its launch profile makes source material
 * a required attachment unless a link is pasted instead - so a page that never
 * mentioned source material left the client with a gallery that stayed empty
 * and no idea that they were the blocker.
 */
export function SourceMaterialCard({
  files,
  hint,
}: {
  files: SourceFile[];
  /** The agent's own words for what it wants, from its launch profile. */
  hint: string;
}) {
  return (
    <section>
      <SectionHeading title="What it cuts from" />
      <div className="rounded-[var(--radius)] border border-border bg-surface-2/50 p-3">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-foreground">Source material</p>
          <Badge tone={files.length > 0 ? "success" : "warning"}>
            {files.length > 0 ? `${files.length} on file` : "Needed"}
          </Badge>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-2">{hint}</p>
        {files.length > 0 && (
          <ul className="mt-2 space-y-1">
            {files.slice(0, 5).map((file) => (
              <li key={file.id} className="flex items-center gap-1.5 text-[11px] text-muted">
                <Icon name="Film" className="h-3 w-3 shrink-0 text-muted-2" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
              </li>
            ))}
            {files.length > 5 && (
              <li className="text-[11px] text-muted-2">+{files.length - 5} more</li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ───────────────────────── daily finder: intake ────────────────────────── */

/**
 * The communities this agent works in, and the ones it must never touch.
 *
 * `offLimitsSubreddits` is BINDING (the intake doc says so) and it is the one
 * field on this page a client will want to verify at a glance - "did they
 * actually record that we were banned from r/SEO" is not a question anyone
 * should have to open a form to answer.
 *
 * Everything here came through `toRedditIntakeView`, which builds its result by
 * whitelist: no ids, no uids, no timestamps, none of the X or LinkedIn fields
 * that share the same intake document.
 */
export function FinderIntakeCard({
  intake,
  href,
  label,
  ready,
}: {
  intake: RedditIntakeView | null;
  href: string;
  label: string;
  ready: boolean;
}) {
  return (
    <section>
      <SectionHeading title="Where it looks" />
      <div className="rounded-[var(--radius)] border border-border bg-surface-2/50 p-3">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-foreground">{label}</p>
          <Badge tone={ready ? "success" : "warning"}>{ready ? "Saved" : "Needed"}</Badge>
        </div>

        {intake ? (
          <div className="mt-2 space-y-2">
            {intake.handle && (
              <p className="font-mono text-[11px] text-muted">{intake.handle}</p>
            )}
            {intake.mode && (
              <p className="text-[11px] leading-relaxed text-muted-2">
                {intake.mode === "warming"
                  ? "Warming up: pure-value answers only, no product mentions, until the account has real history."
                  : "Established: a disclosed mention is allowed where the community permits it."}
              </p>
            )}
            {intake.subreddits && intake.subreddits.length > 0 && (
              <ChipList label="Looks in" tone="neutral" values={intake.subreddits} />
            )}
            {intake.offLimitsSubreddits && intake.offLimitsSubreddits.length > 0 && (
              <ChipList label="Never posts in" tone="warning" values={intake.offLimitsSubreddits} />
            )}
          </div>
        ) : (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-2">
            This agent needs your Reddit account and the communities you are part of before it can
            find anything for you.
          </p>
        )}

        <Link
          href={href}
          className="mt-2 inline-flex items-center gap-1 text-xs text-neon hover:underline"
        >
          {ready ? "Review it" : "Set it up"} <Icon name="ArrowRight" className="h-3 w-3" />
        </Link>
      </div>
    </section>
  );
}

function ChipList({
  label,
  values,
  tone,
}: {
  label: string;
  values: string[];
  tone: "neutral" | "warning";
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-[0.08em] text-muted-2">{label}</p>
      <ul className="flex flex-wrap gap-1">
        {values.map((value) => (
          <li key={value}>
            <Badge tone={tone}>{value}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <h2 className="mb-3 font-mono text-sm uppercase tracking-[0.1em] text-muted">{title}</h2>
  );
}
