import "server-only";

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

const FIREFLIES_ENDPOINT = "https://api.fireflies.ai/graphql";

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
