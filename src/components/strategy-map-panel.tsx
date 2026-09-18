import { Badge } from "@/components/ui";
import { summariseStrategyMap, type StrategyMap } from "@/lib/agent-engine/learning-strategy-map";
import type { LearningPlatform } from "@/lib/agent-engine/learning-feedback";

/**
 * THE STRATEGY MAP, READ BY A PERSON (C1, SCRUM-486).
 *
 * The topic pool the agents draft from: one row per problem worth writing
 * about, with the funnel stage it serves and whether a run has used it. It has
 * been built and consumed for weeks with nobody able to look at it.
 *
 * What it is FOR, on this page: the subject table under it says what the client
 * has already been given, and this says what is left to give. Read together they
 * answer the only two questions an account manager has before a planning call.
 *
 * ## An absent map is an ordinary state
 *
 * The engine builds the map lazily, on the first drafting run that finds none.
 * So a client who has been set up and not yet run has no map, and that is
 * correct rather than broken — this renders nothing at all for them rather than
 * an error or an empty frame demanding attention.
 */

const PLATFORM_LABEL: Record<LearningPlatform, string> = {
  x: "X",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  instagram: "Instagram",
  tiktok: "TikTok",
};

function MapForPlatform({ platform, map }: { platform: LearningPlatform; map: StrategyMap }) {
  const { total, used, remaining, stages } = summariseStrategyMap(map);
  /* The pool running dry is the one thing here worth a colour: a map with no
     unused rows is a client about to repeat itself, and the map is rebuilt from
     scratch rather than topped up, so it needs a person. Three or fewer is the
     warning rather than zero, because a weekly cadence eats three in a
     fortnight. */
  const tone = remaining === 0 ? "danger" : remaining <= 3 ? "warning" : "neutral";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="font-label text-[11px] uppercase tracking-[0.08em] text-muted">{PLATFORM_LABEL[platform]}</h4>
        <p className="flex items-center gap-2 text-xs text-muted">
          <Badge tone={tone}>{remaining} left</Badge>
          <span className="text-muted-2">
            {used} of {total} used · {stages.attention} attention · {stages.expertise} expertise · {stages.decide} decide
          </span>
        </p>
      </div>
      {map.audience.length > 0 && (
        <p className="text-xs text-muted">Written for: {map.audience.join(", ")}.</p>
      )}
      <ul className="space-y-1.5">
        {map.rows.map((row) => (
          <li key={row.id} className="flex items-baseline gap-2 text-sm">
            {/* The used rows stay visible and recede. Hiding them would make the
                pool look permanently full, and they are the record of which
                idea became which post. */}
            <span className={row.usedByRunId ? "text-muted-2 line-through" : "text-foreground"}>
              {row.idea ?? row.problem ?? row.id}
            </span>
            <span className="shrink-0 text-xs text-muted-2">{row.stage}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StrategyMapPanel({
  byPlatform,
}: {
  /** Per platform: the map, `null` when the client has none yet, `undefined` when it could not be read. */
  byPlatform: Record<string, StrategyMap | null | undefined>;
}) {
  const entries = Object.entries(byPlatform) as Array<[LearningPlatform, StrategyMap | null | undefined]>;
  const withMaps = entries.filter((e): e is [LearningPlatform, StrategyMap] => e[1] != null && e[1].rows.length > 0);
  const unreachable = entries.filter(([, map]) => map === undefined).map(([platform]) => PLATFORM_LABEL[platform]);

  // Nothing to say: no map yet is the ordinary state before the first run, and a
  // frame that says so on every new client is furniture nobody reads.
  if (withMaps.length === 0 && unreachable.length === 0) return null;

  return (
    <div className="space-y-5">
      {withMaps.map(([platform, map]) => (
        <MapForPlatform key={platform} platform={platform} map={map} />
      ))}
      {unreachable.length > 0 && <p className="text-xs text-muted-2">Could not read: {unreachable.join(", ")}.</p>}
    </div>
  );
}
