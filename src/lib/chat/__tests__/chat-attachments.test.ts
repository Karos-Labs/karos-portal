import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MAX_CHAT_ATTACHMENTS, parseChatAttachments } from "../chat-attachments";

/**
 * T-B5: the copilot chat's first real file-upload surface needs its
 * server-side validation to actually hold, not just exist. This drives
 * `parseChatAttachments` with the exact shape chatbot-widget.tsx's
 * `RunAttachments` control produces after a real signed-URL upload, plus the
 * malformed/hostile shapes an attacker-controlled request body can carry
 * regardless of what the browser control itself would ever send.
 *
 * The tenancy cases (a `gs://` URI for another client, or under this bucket
 * but outside the run-attachments prefix) are the direct fix for a review
 * finding against a prior version of this module: it validated URI SCHEME
 * only, so a plain CLIENT_USER (this capability's first non-staff caller)
 * could hand back an arbitrary existing `gs://` object path - including
 * another client's - and have it injected as "source media" for their own
 * run with no LLM cooperation required. `https://` is dropped entirely for
 * the same reason: nothing in the real upload flow ever produces one, and
 * there is no scoped way to prove a client-supplied external URL is theirs
 * to reference.
 */
const CLIENT_ID = "acme-co";
const BUCKET = "karos-media";
const OWN_PREFIX = `gs://${BUCKET}/clients/${CLIENT_ID}/run-attachments/`;

describe("parseChatAttachments", () => {
  const originalBucket = process.env.GCS_MEDIA_BUCKET;

  beforeEach(() => {
    process.env.GCS_MEDIA_BUCKET = BUCKET;
  });

  afterEach(() => {
    if (originalBucket === undefined) delete process.env.GCS_MEDIA_BUCKET;
    else process.env.GCS_MEDIA_BUCKET = originalBucket;
  });

  it("accepts a well-formed gs:// attachment under this client's own run-attachments prefix, defaulting role to source", () => {
    const out = parseChatAttachments(
      [{ uri: `${OWN_PREFIX}123-photo.jpg`, contentType: "image/jpeg", label: "photo.jpg" }],
      CLIENT_ID,
    );
    expect(out).toEqual([
      {
        uri: `${OWN_PREFIX}123-photo.jpg`,
        role: "source",
        contentType: "image/jpeg",
        label: "photo.jpg",
      },
    ]);
  });

  it("keeps an explicit recognized role instead of defaulting it", () => {
    const out = parseChatAttachments([{ uri: `${OWN_PREFIX}a.png`, role: "reference" }], CLIENT_ID);
    expect(out[0].role).toBe("reference");
  });

  it("falls back an unrecognized role to source rather than passing it through", () => {
    const out = parseChatAttachments([{ uri: `${OWN_PREFIX}a.png`, role: "arbitrary-role" }], CLIENT_ID);
    expect(out[0].role).toBe("source");
  });

  it("drops an entry with no uri", () => {
    expect(parseChatAttachments([{ role: "source" }], CLIENT_ID)).toEqual([]);
  });

  it("drops an entry whose uri is a local path or unsupported scheme", () => {
    expect(parseChatAttachments([{ uri: "/etc/passwd" }], CLIENT_ID)).toEqual([]);
    expect(parseChatAttachments([{ uri: "file:///etc/passwd" }], CLIENT_ID)).toEqual([]);
    expect(parseChatAttachments([{ uri: "javascript:alert(1)" }], CLIENT_ID)).toEqual([]);
  });

  it("rejects https:// entirely - not just an unrecognized scheme, a deliberately excluded one", () => {
    expect(parseChatAttachments([{ uri: "https://example.com/a.png" }], CLIENT_ID)).toEqual([]);
    expect(parseChatAttachments([{ uri: "https://attacker.example/payload.mp4" }], CLIENT_ID)).toEqual([]);
  });

  it("drops a gs:// object in the right bucket but belonging to ANOTHER client (tenancy, not just bucket membership)", () => {
    const otherClientUri = `gs://${BUCKET}/clients/some-other-client/run-attachments/1-secret.mp4`;
    expect(parseChatAttachments([{ uri: otherClientUri }], CLIENT_ID)).toEqual([]);
  });

  it("drops a gs:// object under this client's OWN prefix but outside run-attachments (e.g. a deliverable, not an upload)", () => {
    const deliverableUri = `gs://${BUCKET}/clients/${CLIENT_ID}/deliverables/finished-post.mp4`;
    expect(parseChatAttachments([{ uri: deliverableUri }], CLIENT_ID)).toEqual([]);
  });

  it("drops a gs:// object in a DIFFERENT bucket than GCS_MEDIA_BUCKET, even with an otherwise-matching path", () => {
    const wrongBucketUri = `gs://not-the-configured-bucket/clients/${CLIENT_ID}/run-attachments/1-a.png`;
    expect(parseChatAttachments([{ uri: wrongBucketUri }], CLIENT_ID)).toEqual([]);
  });

  it("returns nothing (accepts nothing) when GCS_MEDIA_BUCKET is unset, rather than a laxer fallback check", () => {
    delete process.env.GCS_MEDIA_BUCKET;
    expect(parseChatAttachments([{ uri: `${OWN_PREFIX}a.png` }], CLIENT_ID)).toEqual([]);
  });

  it("returns nothing when clientId is missing/empty, even for an otherwise well-formed attachment", () => {
    expect(parseChatAttachments([{ uri: `${OWN_PREFIX}a.png` }], "")).toEqual([]);
  });

  it("drops one malformed or out-of-tenant entry without discarding the rest of the array", () => {
    const out = parseChatAttachments(
      [
        { uri: `${OWN_PREFIX}good-1.png` },
        { uri: "not-a-real-uri" },
        { uri: `gs://${BUCKET}/clients/other-client/run-attachments/x.png` },
        null,
        "a bare string",
        { uri: `${OWN_PREFIX}good-2.png` },
      ],
      CLIENT_ID,
    );
    expect(out.map((a) => a.uri)).toEqual([`${OWN_PREFIX}good-1.png`, `${OWN_PREFIX}good-2.png`]);
  });

  it("caps the array at MAX_CHAT_ATTACHMENTS even when the body claims more", () => {
    const many = Array.from({ length: MAX_CHAT_ATTACHMENTS + 10 }, (_, i) => ({ uri: `${OWN_PREFIX}f${i}.png` }));
    const out = parseChatAttachments(many, CLIENT_ID);
    expect(out).toHaveLength(MAX_CHAT_ATTACHMENTS);
  });

  it("returns an empty array for non-array input (missing, null, an object, a string)", () => {
    expect(parseChatAttachments(undefined, CLIENT_ID)).toEqual([]);
    expect(parseChatAttachments(null, CLIENT_ID)).toEqual([]);
    expect(parseChatAttachments({ uri: `${OWN_PREFIX}a.png` }, CLIENT_ID)).toEqual([]);
    expect(parseChatAttachments(`${OWN_PREFIX}a.png`, CLIENT_ID)).toEqual([]);
  });

  it("truncates an oversized contentType/label rather than passing it through unbounded", () => {
    const longLabel = "x".repeat(5000);
    const out = parseChatAttachments([{ uri: `${OWN_PREFIX}a.png`, label: longLabel }], CLIENT_ID);
    expect(out[0].label?.length).toBe(200);
  });

  it("drops an entry whose uri is itself absurdly long", () => {
    const hugeUri = `${OWN_PREFIX}${"a".repeat(3000)}.png`;
    expect(parseChatAttachments([{ uri: hugeUri }], CLIENT_ID)).toEqual([]);
  });
});
