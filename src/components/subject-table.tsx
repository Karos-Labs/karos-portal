import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/icon";
import { summariseSubjects, type SubjectRow } from "@/lib/agent-engine/learning-subjects";
import type { LearningPlatform } from "@/lib/agent-engine/learning-feedback";

/**
 * THE SUBJECT TABLE, FOR A PERSON (B1, SCRUM-493).
 *
 * The agents have been able to see this for weeks and the people running the
 * accounts could not. It answers, as one list, the question that used to be
 * answered from memory: what have we already said to this audience, what was
 * each piece FOR, and what happened to it.
 *
 * ## Staff only, and that is a product decision rather than a shortcut
 *
 * A subject row carries the machinery's own vocabulary — a run id, a funnel
 * stage, an anti-repetition window. `stage` in particular is a word the client
 * has never been shown and D34 keeps internal ("the sector overlay and the
 * platform pages are internal"). The client's view of the same work is their
 * calendar and their drafts, which already exist. So this renders inside
 * `StaffOnlySection`, like the run history beside it.
 *
 * ## Three states, and they are not the same state
 *
 * `undefined` rows mean the control plane could not be asked; an empty array
 * means it was asked and this platform has drafted nothing. Collapsing the two
 * would tell an operator "nothing here yet" about a client with a hundred rows
 * and an unreachable middleware, which is the kind of quiet wrong answer the
 * learning loop has already produced once.
 */

const PLATFORM_LABEL: Record<LearningPlatform, string> = {
  x: "X",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  instagram: "Instagram",
  tiktok: "TikTok",
};

/**
 * Status → tone. `posted` is the only success: everything else is either still
 * in flight or a decision not to publish, and colouring `approved` green would
 * tell an operator scanning the column that the work is out when it is not.
 */
const STATUS_TONE: Record<SubjectRow["status"], "success" | "info" | "warning" | "neutral"> = {
  posted: "success",
  approved: "info",
  drafted: "neutral",
  change_requested: "warning",
  skipped: "neutral",
};

const STATUS_LABEL: Record<SubjectRow["status"], string> = {
  posted: "posted",
  approved: "approved",
  drafted: "drafted",
  change_requested: "changes asked",
  skipped: "skipped",
};

/** The middleware serialises ISO 8601; a row with an unparseable date shows nothing rather than "Invalid Date". */
function day(iso?: string): string {
  // `·` rather than an em dash: `client-copy-boundary.test.ts` refuses one in
  // anything a browser renders, and this component sits on a client page even
  // though only staff are shown it.
  if (!iso) return "·";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "·";
  return new Date(at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function StageMix({ rows }: { rows: readonly SubjectRow[] }) {
  const { total, posted, stages } = summariseSubjects(rows);
  return (
    <p className="text-xs text-muted">
      {total} subject{total === 1 ? "" : "s"} · {posted} posted ·{" "}
      {/* D32's default mix is three attention, two expertise, one decide per six
          posts. Printed as the counts rather than as a verdict: nobody has
          agreed a tolerance, and a red "off-mix" chip nobody can act on is
          worse than the three numbers. */}
      <span className="text-muted-2">
        {stages.attention} attention · {stages.expertise} expertise · {stages.decide} decide
      </span>
    </p>
  );
}

function PlatformTable({ platform, rows }: { platform: LearningPlatform; rows: readonly SubjectRow[] }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="font-label text-[11px] uppercase tracking-[0.08em] text-muted">{PLATFORM_LABEL[platform]}</h4>
        <StageMix rows={rows} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-1.5 pr-3 font-label text-[10px] uppercase tracking-[0.08em] text-muted-2">Subject</th>
              <th className="py-1.5 pr-3 font-label text-[10px] uppercase tracking-[0.08em] text-muted-2">Stage</th>
              <th className="py-1.5 pr-3 font-label text-[10px] uppercase tracking-[0.08em] text-muted-2">Drafted</th>
              <th className="py-1.5 font-label text-[10px] uppercase tracking-[0.08em] text-muted-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border/60 align-top last:border-0">
                <td className="py-2 pr-3">
                  <span className="block text-foreground">{row.subject}</span>
                  {/* The goal line, where the run wrote one. This is the same
                      goal / who it is for / why now the client sees on the
                      card, and having it HERE is what makes the table a
                      reporting row rather than a list of titles. */}
                  {(row.goal ?? row.audience) && (
                    <span className="mt-0.5 block text-xs text-muted">
                      {row.goal}
                      {row.goal && row.audience ? " · " : ""}
                      {row.audience}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-xs text-muted">{row.stage}</td>
                <td className="py-2 pr-3 text-xs text-muted tabular-nums">{day(row.draftedAt)}</td>
                <td className="py-2">
                  <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SubjectTable({
  byPlatform,
}: {
  /** Per platform: rows, or `undefined` when the control plane could not be asked. */
  byPlatform: Record<string, SubjectRow[] | undefined>;
}) {
  const entries = Object.entries(byPlatform) as Array<[LearningPlatform, SubjectRow[] | undefined]>;
  const withRows = entries.filter((e): e is [LearningPlatform, SubjectRow[]] => (e[1]?.length ?? 0) > 0);
  const unreachable = entries.filter(([, rows]) => rows === undefined).map(([platform]) => PLATFORM_LABEL[platform]);

  if (withRows.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={<Icon name="List" className="h-7 w-7" />}
          title={unreachable.length === entries.length ? "Subject table unavailable" : "No subjects drafted yet"}
          description={
            unreachable.length === entries.length
              ? "The control plane did not answer. This is not the same as an empty table: the rows may exist and could not be read."
              : "The engine writes a row here every time it drafts something, with the goal it was written for. Nothing has run yet."
          }
        />
        {unreachable.length > 0 && unreachable.length < entries.length && (
          <p className="text-xs text-muted-2">Could not read: {unreachable.join(", ")}.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {withRows.map(([platform, rows]) => (
        <PlatformTable key={platform} platform={platform} rows={rows} />
      ))}
      {unreachable.length > 0 && (
        // Named rather than hidden: a platform that could not be read looks
        // exactly like one with nothing drafted, and only this line separates
        // them.
        <p className="text-xs text-muted-2">Could not read: {unreachable.join(", ")}.</p>
      )}
    </div>
  );
}
