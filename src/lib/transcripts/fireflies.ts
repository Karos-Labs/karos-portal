import "server-only";

/** Full transcript — includes text/summary from individual fetch. */
export interface FirefliesTranscript {
  externalId: string;
  title: string;
  date?: number;
  durationMin?: number;
  participants: string[];
  text: string;
  providerSummary?: string;
  providerActionItems?: string[];
}

/** Lightweight header returned by the list query (no sentences). */
export interface FirefliesTranscriptHeader {
  externalId: string;
  title: string;
  date?: number;
  durationMin?: number;
  participants: string[];
}

const KAROS_DOMAIN = "@karoslabs.com";
const FIREFLIES_ENDPOINT = "https://api.fireflies.ai/graphql";

// Header-only list query — no sentences. Full transcript is fetched individually for new records.
const LIST_QUERY = `
  query Transcripts($mine: Boolean, $limit: Int) {
    transcripts(mine: $mine, limit: $limit) {
      id
      title
      date
      duration
      participants
      meeting_attendees { email displayName }
    }
  }
`;

const TRANSCRIPT_QUERY = `
  query Transcript($id: String!) {
    transcript(id: $id) {
      id
      title
      date
      duration
      participants
      meeting_attendees { email displayName }
      summary { overview action_items }
      sentences { text speaker_name }
    }
  }
`;

/**
 * Does `name` (a diarized speaker_name) refer to the same person as `email`?
 * Matches on first name ("albert@..." ~ "Albert Kattan") or on initials, which
 * covers short internal aliases ("dh@..." ~ "Daniel Herbert"). Deliberately
 * loose - the cost of a false merge (a duplicate participant entry) is far
 * lower than the cost we're fixing (a distinct guest silently missing).
 */
function emailLocalPartMatchesName(email: string, name: string): boolean {
  const local = email.split("@")[0]?.toLowerCase();
  if (!local) return false;
  const words = name.trim().toLowerCase().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return false;
  if (words[0] === local) return true;
  const initials = words.map((w) => w[0]).join("");
  return initials.length > 1 && initials === local;
}

/**
 * List recent Fireflies transcripts (header-only, no sentences).
 * Applies the @karoslabs.com invariant; transcripts with no agency participant are dropped.
 * Call fetchFirefliesTranscript(externalId) to get the full text for a specific record.
 *
 * `mine: false` is deliberate: `mine: true` scopes results to meetings recorded
 * under the API key's own Fireflies seat, which silently missed meetings run
 * under a teammate's seat (e.g. a recurring "Karos bi-weekly" someone else
 * hosted/recorded) even though they had an @karoslabs.com participant. The
 * domain invariant below is what actually keeps this agency-scoped.
 */
export async function listFirefliesTranscripts(): Promise<FirefliesTranscriptHeader[]> {
  const key = process.env.FIREFLIES_API_KEY;
  if (!key) throw new Error("FIREFLIES_API_KEY is not set");

  const res = await fetch(FIREFLIES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query: LIST_QUERY, variables: { mine: false, limit: 50 } }),
  });

  if (!res.ok) {
    throw new Error(`Fireflies API error: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const rawList: unknown[] = json?.data?.transcripts ?? [];

  const results: FirefliesTranscriptHeader[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    // Guests who join without a synced calendar email (dial-in, link-only join)
    // still carry a displayName - fall back to it so they aren't silently dropped.
    const attendeeIdentifiers: string[] = Array.isArray(t.meeting_attendees)
      ? (t.meeting_attendees as Array<{ email?: string; displayName?: string }>)
          .map((a) => a?.email || a?.displayName)
          .filter((v): v is string => !!v)
      : [];
    const participantList: string[] = Array.isArray(t.participants) ? (t.participants as string[]) : [];
    const allIdentifiers = [...participantList, ...attendeeIdentifiers];

    // @karoslabs.com invariant — drop meetings with no agency participant
    if (!allIdentifiers.some((e) => e.toLowerCase().includes(KAROS_DOMAIN))) continue;

    const participants = Array.from(new Set(allIdentifiers.filter(Boolean)));

    results.push({
      externalId: String(t.id),
      title: typeof t.title === "string" ? t.title : "Untitled meeting",
      date: t.date ? Number(t.date) : undefined,
      durationMin: t.duration ? Math.round(Number(t.duration)) : undefined,
      participants,
    });
  }
  return results;
}

/** Fetch a single transcript from Fireflies by its id. */
export async function fetchFirefliesTranscript(id: string): Promise<FirefliesTranscript | null> {
  const key = process.env.FIREFLIES_API_KEY;
  if (!key) throw new Error("FIREFLIES_API_KEY is not set");

  const res = await fetch(FIREFLIES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query: TRANSCRIPT_QUERY, variables: { id } }),
  });

  if (!res.ok) {
    throw new Error(`Fireflies API error: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const t = json?.data?.transcript;
  if (!t) return null;

  const attendees: Array<{ email?: string; displayName?: string }> = Array.isArray(t.meeting_attendees)
    ? (t.meeting_attendees as Array<{ email?: string; displayName?: string }>)
    : [];

  // Guests who join without a synced calendar email (dial-in, link-only join)
  // still carry a displayName - fall back to it so they aren't silently dropped.
  // One identifier per attendee, never both, so a single person never
  // occupies two slots from this source alone.
  const attendeeIdentifiers: string[] = attendees
    .map((a) => a?.email || a?.displayName)
    .filter((v): v is string => !!v);

  const knownEmails: string[] = [...(t.participants ?? []), ...attendeeIdentifiers].filter(
    (v): v is string => typeof v === "string" && v.includes("@"),
  );

  // Diarization assigns every sentence a speaker_name independent of calendar/
  // attendee metadata - it's the most reliable record of who was actually on
  // the call, catching guests missing from both of the above. Generic
  // "Speaker N" auto-labels (used when a voice isn't matched to a known
  // identity) are excluded since they aren't real names.
  const sentenceSpeakers: string[] = Array.isArray(t.sentences)
    ? Array.from(
        new Set(
          (t.sentences as Array<{ speaker_name?: string }>)
            .map((s) => s?.speaker_name?.trim())
            .filter((name): name is string => !!name && !/^speaker\s*\d+$/i.test(name)),
        ),
      )
        // Fireflies' attendee records never carry both email and displayName
        // together (each attendee has one field or the other) - there's no
        // linking field back to the email for a named speaker. Correlate by
        // matching the speaker's first name, or initials for short internal
        // aliases like "dh@karoslabs.com" (Daniel Herbert), against the local
        // part of an email already collected. Without this, the same person
        // shows up twice: once as "albert@karoslabs.com", once as "Albert Kattan".
        .filter((name) => !knownEmails.some((email) => emailLocalPartMatchesName(email, name)))
    : [];

  const participants: string[] = Array.from(
    new Set([...(t.participants ?? []), ...attendeeIdentifiers, ...sentenceSpeakers].filter(Boolean)),
  );

  const text: string = Array.isArray(t.sentences)
    ? t.sentences.map((s: { speaker_name?: string; text?: string }) => `${s.speaker_name ?? "Speaker"}: ${s.text ?? ""}`).join("\n")
    : "";

  return {
    externalId: t.id,
    title: t.title ?? "Untitled meeting",
    date: t.date ? Number(t.date) : undefined,
    durationMin: t.duration ? Math.round(Number(t.duration)) : undefined,
    participants,
    text,
    providerSummary: t.summary?.overview ?? undefined,
    providerActionItems: Array.isArray(t.summary?.action_items)
      ? t.summary.action_items
      : typeof t.summary?.action_items === "string"
        ? t.summary.action_items.split("\n").filter(Boolean)
        : undefined,
  };
}
