import { getCurrentUser } from "@/lib/auth";
import { getClient, getAsset } from "@/lib/data";
import {
  buildSimulationPersonas,
  runSimulation,
  type SimulationArtifact,
} from "@/lib/simulation-engine";
import type { Asset, Client } from "@/lib/types";

export const maxDuration = 60;

function inferBusinessModel(client: Client): "B2B" | "B2C" | "MIXED" | null {
  const hay = `${client.industry ?? ""} ${client.category ?? ""} ${client.description ?? ""}`.toLowerCase();
  const b2bHint = /\bb2b\b|enterprise|procurement|compliance|saas|software|platform|agency|consulting|services/.test(hay);
  const b2cHint = /\bb2c\b|consumer|retail|ecommerce|shopper|lifestyle|fashion|beauty|food|travel/.test(hay);
  if (b2bHint && b2cHint) return "MIXED";
  if (b2bHint) return "B2B";
  if (b2cHint) return "B2C";
  return null;
}

function inferPostFormat(asset: Asset): string {
  const channels = (asset.channels ?? []).map((c) => c.toLowerCase());
  const slides = Array.isArray(asset.meta?.slides) ? asset.meta.slides : [];
  const isCarousel = slides.length > 1;
  const body = `${asset.title} ${asset.content}`.toLowerCase();

  if (asset.type === "article") return "Long-form article / technical blog";
  if (asset.type === "email") return "Newsletter issue / marketing email";
  if (asset.type === "instagram_post") {
    return isCarousel ? "Instagram carousel post" : "Instagram image post";
  }
  if (asset.type === "social_post") {
    if (channels.includes("linkedin")) return isCarousel ? "LinkedIn carousel post" : "LinkedIn social post";
    if (channels.includes("instagram")) return isCarousel ? "Instagram carousel post" : "Instagram social post";
    if (channels.includes("tiktok")) return "Short explainer video / TikTok script";
    if (channels.includes("youtube")) return "Short explainer video / YouTube short";
    if (/\bvideo|reel|tiktok|shorts|script\b/.test(body)) return "Short explainer video script";
    return isCarousel ? "Social media carousel post" : "Social media post";
  }
  if (asset.type === "note" && /\bvideo|reel|script|walkthrough|demo\b/.test(body)) {
    return "Short explainer video script";
  }
  return asset.type.replace(/_/g, " ");
}

/**
 * Pre-Flight Impact Simulation — run one asset's artifact past the synthetic
 * persona panel and return every persona's verdict. On-demand (triggered from
 * the "Audience Simulation" tab), one round-trip: the engine dispatches all
 * personas in parallel server-side and this returns them together, each entry
 * carrying its own verdict OR error so the UI degrades gracefully.
 *
 * The artifact content is read from Firestore by asset id (never trusted from
 * the client), and the asset is verified to belong to the client in the path.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.disabled) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: clientId } = await params;
  if (user.role === "CLIENT_USER" && user.clientId !== clientId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { assetId?: string };
  if (!body.assetId) {
    return Response.json({ error: "assetId is required" }, { status: 400 });
  }

  const [client, asset] = await Promise.all([getClient(clientId), getAsset(body.assetId)]);
  if (!client) return Response.json({ error: "Client not found" }, { status: 404 });
  if (!asset || asset.clientId !== clientId) {
    return Response.json({ error: "Asset not found" }, { status: 404 });
  }
  if (!asset.content?.trim()) {
    return Response.json({ error: "This asset has no content to simulate." }, { status: 422 });
  }

  const artifact: SimulationArtifact = {
    title: asset.title,
    content: asset.content,
    type: asset.type,
    format: inferPostFormat(asset),
    channels: asset.channels,
  };
  const businessModel = inferBusinessModel(client);
  const personas = await buildSimulationPersonas(artifact, {
    clientId,
    clientName: client.name,
    industry: client.industry ?? null,
    category: client.category ?? null,
    toneOfVoice: client.brandVoice ?? null,
    targetMarket: client.description ?? null,
    businessModel,
  });

  const results = await runSimulation(artifact, personas, {
    clientId,
    clientName: client.name,
    industry: client.industry ?? null,
    category: client.category ?? null,
    toneOfVoice: client.brandVoice ?? null,
    targetMarket: client.description ?? null,
    businessModel,
  });

  return Response.json({ assetId: asset.id, results });
}
