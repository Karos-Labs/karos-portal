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
 * Fetch recent transcripts from Fireflies (up to 50).
 * Applies the @karoslabs.com domain invariant: transcripts with no @karoslabs.com
 * participant are silently dropped before being returned.
 */
/**
 * List recent Fireflies transcripts (header-only, no sentences).
 * Applies the @karoslabs.com invariant; transcripts with no agency participant are dropped.
 * Call fetchFirefliesTranscript(externalId) to get the full text for a specific record.
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
    body: JSON.stringify({ query: LIST_QUERY, variables: { mine: true, limit: 50 } }),
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
    const attendeeEmails: string[] = Array.isArray(t.meeting_attendees)
      ? (t.meeting_attendees as Array<{ email?: string }>).map((a) => a?.email ?? "")
      : [];
    const participantList: string[] = Array.isArray(t.participants) ? (t.participants as string[]) : [];
    const allEmails = [...participantList, ...attendeeEmails];

    // @karoslabs.com invariant — drop meetings with no agency participant
    if (!allEmails.some((e) => e.toLowerCase().includes(KAROS_DOMAIN))) continue;

    const participants = Array.from(
      new Set([...participantList, ...attendeeEmails.filter(Boolean)].filter(Boolean)),
    );

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

  const attendees: string[] = Array.isArray(t.meeting_attendees)
    ? t.meeting_attendees.map((a: { email?: string }) => a?.email).filter(Boolean)
    : [];
  const participants: string[] = Array.from(
    new Set([...(t.participants ?? []), ...attendees].filter(Boolean)),
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
