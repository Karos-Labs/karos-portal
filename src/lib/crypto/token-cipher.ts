/**
 * Token cipher — symmetric encryption for OAuth tokens at rest.
 *
 * Employee-seat LinkedIn tokens are encrypted with AES-256-GCM before they touch
 * Firestore, keyed by TOKEN_ENCRYPTION_KEY (a 32-byte key, hex or base64). GCM
 * gives us authenticated encryption, so tampering is detected on decrypt.
 *
 * Fails closed in production: if the key is missing we refuse to "encrypt"
 * (throwing rather than silently storing plaintext). In dev without a key, values
 * are stored with a `plain:` marker so the round-trip still works locally — the
 * marker makes it unmistakable that the value is NOT encrypted.
 *
 * Server-only (uses node:crypto).
 */

import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const PLAIN_PREFIX = "plain:";
const ENC_PREFIX = "enc:v1:";

function loadKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  // Accept hex (64 chars) or base64; must decode to exactly 32 bytes.
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes (hex or base64)");
  }
  return buf;
}

/** Encrypt a token for storage. Returns an `enc:v1:` blob, or a `plain:` marker in dev. */
export function encryptToken(plaintext: string): string {
  const key = loadKey();
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TOKEN_ENCRYPTION_KEY is required to store employee-seat tokens in production");
    }
    return `${PLAIN_PREFIX}${plaintext}`;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // enc:v1:<iv>.<tag>.<ciphertext> — all base64.
  return `${ENC_PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

/** Decrypt a stored token blob produced by encryptToken. */
export function decryptToken(stored: string): string {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy/plaintext value written before encryption existed — return as-is.
    return stored;
  }
  const key = loadKey();
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required to decrypt employee-seat tokens");
  const [ivB64, tagB64, dataB64] = stored.slice(ENC_PREFIX.length).split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted token blob");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** True when a stored value is genuinely encrypted (not a dev plaintext marker). */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

/** Encrypt every value in a credentials map (keys unchanged). */
export function encryptCredentials(creds: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, encryptToken(v)]));
}

/** Decrypt every value in a stored credentials map (keys unchanged). */
export function decryptCredentials(creds: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, decryptToken(v)]));
}

/**
 * Decrypt a credentials map for READ paths that must survive an environment
 * without the key.
 *
 * Production writes `enc:v1:` blobs with a key a laptop pointed at the same
 * Firestore has no business holding — so "cannot decrypt here" is a normal
 * state for local dev, not corruption. A page listing integrations was crashing
 * on it (ClientDetailPage via listClientIntegrations), taking down surfaces
 * that never render a token at all. Values that cannot be decrypted are
 * DROPPED and the caller is told, so the row can say "connected, secrets
 * unreadable here" instead of the page dying.
 *
 * Callers that genuinely need the plaintext to do their job (publish cron,
 * analytics sync) keep using decryptCredentials, which still fails loud.
 */
export function decryptCredentialsAvailable(creds: Record<string, string>): {
  credentials: Record<string, string>;
  unavailable: boolean;
} {
  const out: Record<string, string> = {};
  let unavailable = false;
  for (const [k, v] of Object.entries(creds)) {
    try {
      out[k] = decryptToken(v);
    } catch {
      unavailable = true;
    }
  }
  return { credentials: out, unavailable };
}
