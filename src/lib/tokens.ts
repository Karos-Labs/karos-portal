import "server-only";

import { randomBytes, createHash } from "node:crypto";

import {
  createAccessToken,
  findAccessTokenByHash,
  updateAccessToken,
  getUser,
} from "@/lib/data";
import type { AppUser } from "@/lib/types";

const PREFIX = "karos_pat_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a personal access token for `uid`. Stores only the hash; returns the
 * plaintext ONCE so the caller can show it to the user — it cannot be recovered.
 */
export async function issueAccessToken(uid: string, name: string): Promise<{ id: string; token: string }> {
  const token = PREFIX + randomBytes(24).toString("hex");
  const id = await createAccessToken({
    uid,
    name: name.trim() || "Untitled token",
    prefix: token.slice(0, PREFIX.length + 6),
    tokenHash: hashToken(token),
    createdAt: Date.now(),
    lastUsedAt: null,
  });
  return { id, token };
}

/**
 * Resolve a bearer token to a staff user, or null. Verifies the token exists and
 * is not revoked, the owner is an enabled employee/admin, then stamps last-used.
 */
export async function userFromToken(token: string | undefined): Promise<AppUser | null> {
  if (!token || !token.startsWith(PREFIX)) return null;
  const record = await findAccessTokenByHash(hashToken(token));
  if (!record || record.revoked) return null;
  const user = await getUser(record.uid);
  if (!user || user.disabled) return null;
  if (user.role !== "admin" && user.role !== "employee") return null;
  // Fire-and-forget; never block auth on the write.
  updateAccessToken(record.id, { lastUsedAt: Date.now() }).catch(() => {});
  return user;
}
