import "server-only";

import { getClient, updateClient } from "@/lib/data";
import { uploadBytes, deleteObject } from "@/lib/storage";
import { BRAND_LOGO_MAX_BYTES, checkBrandLogoFile } from "@/lib/brand-logo-file";
import { projectClientOnSaveInBackground } from "@/lib/agent-engine/project-on-save";
import { publicWebsiteUrl } from "@/lib/onboarding-discovery-parse";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Store a logo the client approved in the onboarding chat (found on their own
 * site) as their logo: downloaded, checked against the same type and size
 * rules as an upload (`checkBrandLogoFile`), written to Storage under the same
 * path scheme, and recorded the same way `/api/clients/[id]/logo` records one.
 *
 * The URL came through the browser, so it is held to the public-website rule
 * before the server fetches it, and again after redirects. Throws on any
 * refusal; the caller treats that as "no logo yet".
 */
export async function importLogoFromUrl(clientId: string, rawUrl: string): Promise<{ url: string; path: string }> {
  const source = publicWebsiteUrl(rawUrl);
  if (!source || source.protocol !== "https:") throw new Error("Not a public https image URL");

  const res = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Logo download returned ${res.status}`);
  if (!publicWebsiteUrl(res.url || source.toString())) throw new Error("Logo redirected off the public web");
  const declaredLength = Number(res.headers.get("content-length") ?? "0");
  if (declaredLength > BRAND_LOGO_MAX_BYTES) throw new Error("Logo is too large");
  const bytes = Buffer.from(await res.arrayBuffer());

  const name = decodeURIComponent(source.pathname.split("/").pop() || "logo");
  const check = checkBrandLogoFile({
    name,
    type: (res.headers.get("content-type") ?? "").split(";")[0]!.trim(),
    size: bytes.length,
  });
  if (!check.ok) throw new Error(check.error);

  const client = await getClient(clientId);
  if (!client) throw new Error("Client not found");
  const safeName = name.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "logo";
  const path = `clients/${clientId}/logos/${crypto.randomUUID()}-${safeName}`;
  const { url } = await uploadBytes({ bytes, path, contentType: check.contentType });
  await updateClient(clientId, { logoUrl: url, logoStoragePath: path });
  projectClientOnSaveInBackground(clientId, "logo-uploaded");
  // The previous file goes only after the new one is recorded (as the route does).
  if (client.logoStoragePath && client.logoStoragePath !== path) {
    await deleteObject(client.logoStoragePath).catch(() => {});
  }
  return { url, path };
}
